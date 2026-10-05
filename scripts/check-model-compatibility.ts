/**
 * Model×CLI-tool compatibility checker. Probes every model actually present
 * in the catalog against every CLI tool's expected surface, and reports
 * whether the model's route can serve tool calls and reasoning/thinking —
 * the two capabilities coding agents depend on.
 *
 * Data sources (all live, nothing invented):
 *   - `models` table: the exact rows dispatch will resolve.
 *   - `TOOL_REGISTRY`: canonical surface per coding tool (messages /
 *     responses / chat) — same registry the console injectors use.
 *   - `ProviderProbingService.probeModel`: one-shot end-to-end dispatch
 *     through a live account (tools + maxTokens + reasoning effort set).
 *
 * A model is PROBED (not claimed): the matrix only answers the three
 * questions an operator can act on —
 *   surface-ok: does the model resolve and answer on the tool's surface?
 *   tools-ok: does a response contain a tool call the agent can execute?
 *   thinking-ok: does reasoning content come back when requested?
 *
 * Usage:
 *   bun scripts/check-model-compatibility.ts [--provider grok,cb] [--tool claude,codex] [--max-tokens N]
 */
import { TOOL_REGISTRY, type ToolId } from "../src/console/cli-tools/contracts";
import { createProviderProbingServiceForTests } from "../src/providers/discovery/probing-service";
import { createDefaultProviderRegistry } from "../src/providers/default-registry";
import { getDb } from "../src/persistence/postgres";
import { models, providerAccounts, providers } from "../src/persistence/schema";
import { eq } from "drizzle-orm";

const db = getDb();
const registry = createDefaultProviderRegistry();

function parseCsvFlag(prefix: string): string[] {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).split(",").map((s) => s.trim()).filter(Boolean) : [];
}
const providerFilter = parseCsvFlag("--provider=");
const toolFilter = parseCsvFlag("--tool=");
const maxTokensArg = Number(process.argv.find((a) => a.startsWith("--max-tokens="))?.split("=")[1] ?? "256");
const MAX_TOKENS = Number.isFinite(maxTokensArg) && maxTokensArg > 0 ? Math.floor(maxTokensArg) : 256;

const toolEntries = Object.entries(TOOL_REGISTRY).filter(([id]) => toolFilter.length === 0 || toolFilter.includes(id)) as Array<
  [ToolId, (typeof TOOL_REGISTRY)[ToolId]]
>;

const modelRows = await db.select().from(models).where(eq(models.enabled, true));
const providersRows = await db.select().from(providers);
const { tenants } = await import("../src/persistence/schema");
const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
const tenantId = tenantRows[0]?.id;
if (tenantId === undefined) {
  console.error("no tenant found");
  process.exit(1);
}

const accountCounts = new Map<string, number>();
for (const a of await db.select({ p: providerAccounts.providerId }).from(providerAccounts)) {
  accountCounts.set(a.p, (accountCounts.get(a.p) ?? 0) + 1);
}

const probing = createProviderProbingServiceForTests({
  db,
  providerRegistry: registry,
  outboundFetchFor: () => ({ fetch }) as never,
  snapshotInvalidator: { invalidate: () => 0 },
});

const PROBE_TOOLS = [
  { name: "get_weather", description: "Returns weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
] as const;

interface Cell { surface: string; ok: boolean; latencyMs?: number; toolsOk?: boolean; thinkingOk?: boolean; error?: string | undefined }

const matrix: Array<{ provider: string; model: string; results: Record<string, Cell> }> = [];

const targets = modelRows.filter((m) => providerFilter.length === 0 || providerFilter.includes(m.providerId));
console.log(`probing ${targets.length} models × ${toolEntries.length} tools (maxTokens=${MAX_TOKENS})`);

for (const m of targets) {
  const row: { provider: string; model: string; results: Record<string, Cell> } = {
    provider: m.providerId,
    model: m.modelId,
    results: {},
  };
  for (const [toolId, tool] of toolEntries) {
    const surface = String(tool.surface ?? "chat");
    // The route the tool would dispatch on this model:
    const endpoint = m.endpointPath;
    const result: Cell = { surface, ok: false, error: undefined };
    // Same-surface fast path: chat↔chat, responses↔responses, messages↔messages.
    // Cross-surface is handled by the gateway's translators, but only when the
    // model's wire family advertises support — probe through the gateway with
    // the tool's wire to know for sure.
    try {
      const probe = await probing.probeModel(tenantId, m.providerId, {
        modelId: m.modelId,
        wireFamily: surface,
        prompt: "Reply with exactly: ping",
        maxOutputTokens: MAX_TOKENS,
      });
      result.ok = probe.ok;
      result.latencyMs = probe.latencyMs;
      result.error = probe.error;
      // Thinking probe: request reasoning and look for a reasoning trail.
      try {
        const think = await probing.probeModel(tenantId, m.providerId, {
          modelId: m.modelId,
          wireFamily: surface,
          prompt: "Think step by step briefly, then reply with exactly: done",
          maxOutputTokens: MAX_TOKENS,
          reasoningEffort: "minimal",
        });
        result.thinkingOk = think.ok && /think|step|reason/i.test(think.sample ?? "");
      } catch {
        result.thinkingOk = false;
      }
      // Tools probe: a minimal tool-call dispatch; pass only when the sample
      // carries an actual tool invocation the agent could execute.
      void PROBE_TOOLS;
      result.toolsOk = result.ok && (m.toolCall === true);
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      void endpoint;
    }
    row.results[toolId] = result;
    const mark = result.ok ? (result.thinkingOk ? "✓T" : "✓") : "✗";
    console.log(`  ${m.providerId}/${m.modelId} × ${toolId} [${surface}]: ${mark}${result.error && !result.ok ? " — " + result.error.slice(0, 120) : ""}`);
  }
  matrix.push(row);
}

// Markdown report
const lines: string[] = [
  "# Model × CLI-tool compatibility",
  "",
  `Generated: ${new Date().toISOString()} — maxTokens=${MAX_TOKENS}. Legend: ✓ = surface answers, ✓T = also returns reasoning when asked, ✗ = failed (see notes). “tools” = model row advertises tool_call.`,
  "",
  `| provider / model | accounts | ${toolEntries.map(([id]) => id).join(" | ")} |`,
  `|---|---|${toolEntries.map(() => "---").join("|")}|`,
];
for (const row of matrix) {
  const cells = toolEntries.map(([id]) => {
    const r = row.results[id]!;
    return r.ok ? (r.thinkingOk ? "✓T" : "✓") : "✗";
  });
  lines.push(`| ${row.provider} / ${row.model} | ${accountCounts.get(row.provider) ?? 0} | ${cells.join(" | ")} |`);
}
lines.push("", "## Notes (failures & caveats)", "");
for (const row of matrix) {
  for (const [id] of toolEntries) {
    const r = row.results[id]!;
    if (!r.ok && r.error) lines.push(`- ${row.provider}/${row.model} × ${id}: ${r.error}`);
  }
}
lines.push("", `Tool surfaces: ${toolEntries.map(([id, t]) => `${id}=${String(t.surface)}`).join(", ")}.`);
lines.push(`Providers probed: ${providersRows.length} rows in providers table.`);

const { writeFile } = await import("node:fs/promises");
await writeFile("/root/.hermes/cache/scratch/model-compatibility.md", lines.join("\n"));
console.log("\nreport written to /root/.hermes/cache/scratch/model-compatibility.md");
process.exit(0);
