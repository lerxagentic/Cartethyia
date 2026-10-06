// Model benchmark domain: operations and HTTP routes.
//
// A benchmark spends the operator's own provider quota — one real completion
// per model — so both listing and running require a dashboard sign-in
// (`dashboard:read` / `dashboard:write`). Each model gets its own deadline
// rather than the whole batch sharing one: a provider that hangs must not take
// the models after it down.
//
// The probe drives Cartethyia's OWN `/v1/chat/completions` (loopback) with a
// tenant gateway key, so it measures the path a real caller takes — including
// routing, persona injection, and provider selection — not a side channel.

import { Elysia } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import { isRecord } from "../../../protocol/primitives";
import type { BenchmarkRankingEntry, BenchmarkRecentEntry, BenchmarkStore } from "./store";

const MAX_MODELS_PER_RUN = 10;
const DEFAULT_PER_MODEL = 10;
/** Per-model ceiling. A provider that hangs must not stall the batch. */
export const BENCHMARK_MODEL_TIMEOUT_MS = 30_000;
/**
 * The prompt is deterministic and bounded, but not one word: a one-token reply
 * makes tokens/sec round to 0 and says nothing about throughput. Counting to 30
 * yields a few dozen tokens — long enough for a meaningful rate, short enough
 * that the sample stays dominated by latency rather than by output length.
 */
const BENCHMARK_PROMPT = "Count from 1 to 30, separated by single spaces. Output only the numbers.";
/** Room for the ~40-token answer plus any reasoning the model emits first. */
const BENCHMARK_MAX_TOKENS = 400;

export interface BenchmarkProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly outputTokens: number | null;
  readonly error: string | null;
}

export interface BenchmarkProbe {
  /** Runs one real completion for `model` and reports its timing. */
  run(model: string): Promise<BenchmarkProbeResult>;
}

export interface BenchmarkConfig {
  readonly store: BenchmarkStore;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
  /** Builds a probe bound to the caller's tenant (its gateway key). */
  readonly probeFor: (tenantId: string) => BenchmarkProbe;
}

function providerOf(model: string): string | null {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

export function createBenchmarkOperations(config: BenchmarkConfig) {
  const store = config.store;

  async function list(access: AccessDecision | undefined): Promise<{
    ranking: readonly BenchmarkRankingEntry[];
    recent: readonly BenchmarkRecentEntry[];
  }> {
    const authorized = requireTenantScope(access, "dashboard:read");
    const [ranking, recent] = await Promise.all([
      store.ranking(authorized.tenantId, DEFAULT_PER_MODEL),
      store.recent(authorized.tenantId, 50),
    ]);
    return { ranking, recent };
  }

  async function runModels(
    access: AccessDecision | undefined,
    rawModels: unknown,
  ): Promise<{
    results: { id: string; model: string; ok: boolean; latencyMs: number | null; error: string | null }[];
    ranking: readonly BenchmarkRankingEntry[];
  }> {
    const authorized = requireTenantScope(access, "dashboard:write");
    if (!Array.isArray(rawModels)) {
      throw new ConsoleDomainError("invalid_benchmark", 400, "models must be an array");
    }
    const models = Array.from(
      new Set(rawModels.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)),
    ).slice(0, MAX_MODELS_PER_RUN);
    if (models.length === 0) {
      throw new ConsoleDomainError("invalid_benchmark", 400, "at least one model is required");
    }

    const probe = config.probeFor(authorized.tenantId);
    const results: { id: string; model: string; ok: boolean; latencyMs: number | null; error: string | null }[] = [];
    for (const model of models) {
      const started = Date.now();
      let outcome: BenchmarkProbeResult;
      try {
        outcome = await withTimeout(probe.run(model), BENCHMARK_MODEL_TIMEOUT_MS);
      } catch (error) {
        outcome = {
          ok: false,
          latencyMs: Date.now() - started,
          ttftMs: null,
          outputTokens: null,
          error: error instanceof Error ? error.message : "benchmark timed out",
        };
      }
      const id = await store.record(authorized.tenantId, {
        model,
        provider: providerOf(model),
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        ttftMs: outcome.ttftMs,
        outputTokens: outcome.outputTokens,
        error: outcome.ok ? null : (outcome.error ?? "failed"),
      });
      results.push({
        id,
        model,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        error: outcome.ok ? null : (outcome.error ?? "failed"),
      });
    }

    const ranking = await store.ranking(authorized.tenantId, DEFAULT_PER_MODEL);
    return { results, ranking };
  }

  return { list, runModels };
}

export function createBenchmarkRoutes(config: BenchmarkConfig): Elysia {
  const operations = createBenchmarkOperations(config);
  return new Elysia({ prefix: "/benchmark" })
    .get("/", async ({ request, set }) => {
      try {
        return await operations.list(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "Benchmark operation failed");
      }
    })
    .post("/", async ({ request, body, set }) => {
      try {
        const input = isRecord(body) ? body : {};
        return await operations.runModels(config.accessResolver(request), input["models"]);
      } catch (error) {
        return errorResponse(error, set, "Benchmark operation failed");
      }
    }) as unknown as Elysia;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export { BENCHMARK_PROMPT, BENCHMARK_MAX_TOKENS };
