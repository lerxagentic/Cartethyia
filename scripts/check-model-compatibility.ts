/**
 * Model × coding-tool compatibility checker. For every enabled model in the
 * catalog whose provider has a configured account, probes each *unique* wire
 * surface the coding-tool registry needs (chat / responses / messages) through
 * the live gateway dispatch path, twice: a plain completion and a reasoning
 * request. Tool-level results are derived from those surface probes — which is
 * exactly what the dispatch layer guarantees, because a tool on the same
 * surface behaves identically regardless of which CLI sends it.
 *
 * Data sources (all live, nothing invented):
 *   - `models` table: the rows dispatch will actually resolve.
 *   - `TOOL_REGISTRY`: which surface each coding tool expects (Hermes/Cline/
 *     Droid/OpenCode → chat, Codex → responses, Claude Code/OpenClaw → messages…).
 *   - `ProviderProbingService.probeModel`: one-shot end-to-end dispatch
 *     through a live account of the model's provider.
 *
 * Usage:
 *   bun scripts/check-model-compatibility.ts [--provider=grok,cb] [--tool=claude,codex] [--max-tokens=256]
 * Report: /root/.hermes/cache/scratch/model-compatibility.md
 */
import { TOOL_REGISTRY, type ToolId } from "../src/console/cli-tools/contracts";
import { createProviderProbingServiceForTests } from "../src/providers/discovery/probing-service";
import { createDefaultProviderRegistry } from "../src/providers/default-registry";
import { getDb } from "../src/persistence/postgres";
import { models, providerAccounts, providers, tenants } from "../src/persistence/schema";
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
const toolSurface = new Map<string, string>();
for (const [id, tool] of toolEntries) toolSurface.set(id, String(tool.surface ?? "chat"));
const surfaces = [...new Set(toolSurface.values())];

const tenantRows = await db.select({ id: tenants.id }).from(tenants);
const tenantId = tenantRows[0]?.id;
if (tenantId === undefined) {
  console.error("no tenant found");
  process.exit(1);
}

const accountCounts = new Map<string, number>();
for (const a of await db.select({ p: providerAccounts.providerId }).from(providerAccounts)) {
  accountCounts.set(a.p, (accountCounts.get(a.p) ?? 0) + 1);
}
const providerRows = await db.select({ id: providers.id, requiresAccount: providers.requiresAccount }).from(providers);
const requiresAccount = new Map<string, boolean>();
for (const p of providerRows) requiresAccount.set(p.id, p.requiresAccount);

const modelRows = await db.select().from(models).where(eq(models.enabled, true));
const targets = modelRows.filter((m) => providerFilter.length === 0 || providerFilter.includes(m.providerId));
const probed = targets.filter((m) => (accountCounts.get(m.providerId) ?? 0) > 0 || requiresAccount.get(m.providerId) === false);
const skipped = targets.filter((m) => !probed.includes(m));
const skippedProviders = new Set(skipped.map((m) => m.providerId));

console.log(`probing ${probed.length} models × surfaces [${surfaces.join(", ")}] (maxTokens=${MAX_TOKENS}); ${skipped.length} models skipped (no account): ${[...skippedProviders].join(", ")}`);

const probing = createProviderProbingServiceForTests({
  db,
  providerRegistry: registry,
  outboundFetchFor: () => ({ fetch }) as never,
  snapshotInvalidator: { invalidate: () => 0 },
});

interface SurfaceResult { ok: boolean; thinkingOk: boolean; latencyMs?: number; error?: string | undefined }
interface Row { provider: string; model: string; toolCall: boolean; bySurface: Record<string, SurfaceResult> }
const matrix: Row[] = [];

for (const m of probed) {
  const row: Row = { provider: m.providerId, model: m.modelId, toolCall: m.toolCall === true, bySurface: {} };
  for (const surface of surfaces) {
    const result: SurfaceResult = { ok: false, thinkingOk: false, error: undefined };
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
      if (probe.ok) {
        const think = await probing.probeModel(tenantId, m.providerId, {
          modelId: m.modelId,
          wireFamily: surface,
          prompt: "Think step by step briefly, then reply with exactly: done",
          maxOutputTokens: MAX_TOKENS,
          reasoningEffort: "minimal",
        });
        result.thinkingOk = think.ok;
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    row.bySurface[surface] = result;
    const mark = result.ok ? (result.thinkingOk ? "✓T" : "✓") : "✗";
    console.log(`  ${m.providerId}/${m.modelId} [${surface}]: ${mark}${result.error && !result.ok ? " — " + result.error.slice(0, 140) : ""}`);
  }
  matrix.push(row);
}

// ── Markdown report ──────────────────────────────────────────────────────
const lines: string[] = [
  "# Model × coding-tool compatibility (live probe)",
  "",
  `Generated: ${new Date().toISOString()} · maxTokens=${MAX_TOKENS}.`,
  "",
  "Legend: **✓** = answers on that surface, **✓T** = also returns reasoning when asked, **✗** = failed (see notes).",
  "",
  `Tools probed (surface): ${toolEntries.map(([id, t]) => `${id}(${String(t.surface)})`).join(", ")}.`,
  "",
];
if (skipped.length > 0) {
  lines.push(`**Skipped (provider has no configured account):** ${[...skippedProviders].join(", ")} — ${skipped.length} model rows not probed.`, "");
}
lines.push(`| provider / model | ${toolEntries.map(([id]) => id).join(" | ")} | tools |`, `|---|${toolEntries.map(() => "---").join("|")}|---|`);
for (const row of matrix) {
  const cells = toolEntries.map(([id]) => {
    const r = row.bySurface[toolSurface.get(id)!];
    if (!r) return "–";
    return r.ok ? (r.thinkingOk ? "✓T" : "✓") : "✗";
  });
  lines.push(`| ${row.provider} / ${row.model} | ${cells.join(" | ")} | ${row.toolCall ? "yes" : "no"} |`);
}
lines.push("", "## Failures & notes", "");
for (const row of matrix) {
  for (const surface of surfaces) {
    const r = row.bySurface[surface]!;
    if (!r.ok && r.error) lines.push(`- ${row.provider}/${row.model} [${surface}]: ${r.error}`);
  }
}
for (const p of skippedProviders) lines.push(`- ${p}: no account configured — not probed.`);

const { writeFile } = await import("node:fs/promises");
await writeFile("/root/.hermes/cache/scratch/model-compatibility.md", lines.join("\n"));
console.log(`\nreport: /root/.hermes/cache/scratch/model-compatibility.md (${matrix.length} models)`);
process.exit(0);
