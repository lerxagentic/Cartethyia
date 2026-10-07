// Model benchmark domain: the live probe.
//
// Drives Cartethyia's OWN `/v1/chat/completions` over loopback with a tenant
// gateway key, so a benchmark measures the path a real caller takes — routing,
// persona injection, provider selection — rather than a side channel that could
// disagree with production.
//
// Streaming is used even though only the final numbers matter: it is the only
// way to observe time-to-first-token, and TTFT is the figure that distinguishes
// "slow model" from "slow queue".

import { decryptCredentialToString } from "../../../security/crypto";
import type { ApiKeyStore } from "../../../persistence/api-key-store";
import { DEFAULT_API_KEY_LABEL } from "../api-keys/contracts";
import { resolvePort } from "../../../config";
import { log } from "../../../observability/logger";
import type { BenchmarkProbe, BenchmarkProbeResult } from "./contracts";
import { BENCHMARK_MAX_TOKENS, BENCHMARK_PROMPT } from "./contracts";

interface BenchmarkProbeDeps {
  readonly keyStore: ApiKeyStore;
  /** Overridable for tests; defaults to the running server's own port. */
  readonly baseUrl?: string;
}

/** Resolves a usable plaintext gateway key for the tenant, or null. */
async function resolveTenantKey(keyStore: ApiKeyStore, tenantId: string): Promise<string | null> {
  const keys = await keyStore.list(tenantId);
  const usable = (key: (typeof keys)[number]) =>
    key.revokedAt === undefined && key.enabled === true && key.keyEncrypted !== undefined;
  // Prefer the seeded default key, exactly as first boot creates it.
  const preferred =
    keys.find((key) => key.label === DEFAULT_API_KEY_LABEL && key.revokedAt === undefined && usable(key)) ??
    keys.find(usable);
  if (!preferred?.keyEncrypted) return null;
  try {
    return decryptCredentialToString(preferred.keyEncrypted);
  } catch {
    return null;
  }
}

/**
 * Reads the SSE body until the first content delta (for TTFT), then keeps
 * consuming to completion (for total latency and token count). Returns null
 * numbers rather than guessing when a field is absent.
 */
async function measureStream(response: Response, startedAt: number): Promise<BenchmarkProbeResult> {
  if (!response.body) {
    return { ok: true, latencyMs: Date.now() - startedAt, ttftMs: null, outputTokens: null, error: null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | null = null;
  let outputTokens: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames are newline-delimited `data: {...}`; keep the trailing partial.
    const frames = buffer.split("\n");
    buffer = frames.pop() ?? "";
    for (const rawFrame of frames) {
      const frame = rawFrame.trim();
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = parsed["choices"];
      if (Array.isArray(choices) && choices.length > 0) {
        const rawDelta = (choices[0] as Record<string, unknown>)["delta"];
        if (typeof rawDelta === "object" && rawDelta !== null) {
          const delta = rawDelta as Record<string, unknown>;
          const content = typeof delta["content"] === "string" ? delta["content"] : "";
          const reasoning =
            typeof delta["reasoning_content"] === "string"
              ? delta["reasoning_content"]
              : typeof delta["reasoning"] === "string"
                ? delta["reasoning"]
                : "";
          if ((content.length > 0 || reasoning.length > 0) && firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
        }
      }
      const usage = parsed["usage"];
      if (typeof usage === "object" && usage !== null) {
        const completion = (usage as Record<string, unknown>)["completion_tokens"];
        if (typeof completion === "number") outputTokens = completion;
      }
    }
  }
  const finishedAt = Date.now();
  return {
    ok: true,
    latencyMs: finishedAt - startedAt,
    ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
    outputTokens,
    error: null,
  };
}

export function createBenchmarkProbe(deps: BenchmarkProbeDeps) {
  return (tenantId: string): BenchmarkProbe => ({
    async run(model: string): Promise<BenchmarkProbeResult> {
      const key = await resolveTenantKey(deps.keyStore, tenantId);
      if (!key) {
        return {
          ok: false,
          latencyMs: null,
          ttftMs: null,
          outputTokens: null,
          error: "no usable gateway key for this tenant",
        };
      }
      const base = deps.baseUrl ?? `http://127.0.0.1:${resolvePort()}`;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: BENCHMARK_PROMPT }],
            stream: true,
            max_tokens: BENCHMARK_MAX_TOKENS,
            stream_options: { include_usage: true },
            bypass_persona: true,
          }),
        });
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          ttftMs: null,
          outputTokens: null,
          error: error instanceof Error ? error.message : "request failed",
        };
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const text = await response.text();
          if (text.length > 0) detail = text.slice(0, 200);
        } catch {
          // keep the status line
        }
        return { ok: false, latencyMs: Date.now() - startedAt, ttftMs: null, outputTokens: null, error: detail };
      }
      try {
        return await measureStream(response, startedAt);
      } catch (error) {
        // A stream that dies mid-flight is still a failure for ranking.
        log.warn("[benchmark] stream failed", { model, error: String(error) });
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          ttftMs: null,
          outputTokens: null,
          error: error instanceof Error ? error.message : "stream failed",
        };
      }
    },
  });
}
