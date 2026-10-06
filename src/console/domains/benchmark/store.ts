// Model benchmark domain: persistence and ranking.
//
// Ranking is computed from stored runs rather than from a single live probe: a
// benchmark that measured one prompt would rank by noise. Keeping the raw runs
// makes the ranking explainable ("fastest median over the last N runs") and
// lets a later run dilute one unlucky slow sample. Mirrors the 9Router
// benchmark feature, adapted to Cartethyia's tenant-scoped storage.

import { desc, eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { modelBenchmarks } from "../../../persistence/schema";

/** How many recent runs per model feed the ranking. */
export const BENCHMARK_RANKING_WINDOW = 10;
/** Retention: only the most recent rows per tenant are kept. */
export const BENCHMARK_RETAIN_PER_TENANT = 1_000;

export interface BenchmarkRunInput {
  readonly model: string;
  readonly provider: string | null;
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly outputTokens: number | null;
  readonly error: string | null;
}

export interface BenchmarkRankingEntry {
  readonly rank: number | null;
  readonly model: string;
  readonly provider: string | null;
  readonly runs: number;
  readonly ok: number;
  readonly failed: number;
  readonly medianLatencyMs: number | null;
  readonly medianTtftMs: number | null;
  readonly tokensPerSec: number | null;
  readonly lastRunAt: string | null;
  readonly lastError: string | null;
}

export interface BenchmarkRecentEntry {
  readonly id: string;
  readonly model: string;
  readonly provider: string | null;
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly outputTokens: number | null;
  readonly error: string | null;
  readonly at: string;
}

export interface BenchmarkStore {
  record(tenantId: string, run: BenchmarkRunInput): Promise<string>;
  ranking(tenantId: string, perModel: number): Promise<readonly BenchmarkRankingEntry[]>;
  recent(tenantId: string, limit: number): Promise<readonly BenchmarkRecentEntry[]>;
}

function median(values: readonly (number | null)[]): number | null {
  const sorted = values.filter((n): n is number => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export class DrizzleBenchmarkStore implements BenchmarkStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async record(tenantId: string, run: BenchmarkRunInput): Promise<string> {
    const id = `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await this.db.insert(modelBenchmarks).values({
      id,
      tenantId,
      model: run.model,
      provider: run.provider,
      ok: run.ok,
      latencyMs: run.latencyMs === null ? null : Math.round(run.latencyMs),
      ttftMs: run.ttftMs === null ? null : Math.round(run.ttftMs),
      outputTokens: run.outputTokens === null ? null : Math.round(run.outputTokens),
      error: run.error === null ? null : run.error.slice(0, 300),
      at: new Date(),
    });
    // Keep the table bounded per tenant: only recent runs matter for ranking.
    await this.db.execute(sql`
      DELETE FROM ${modelBenchmarks}
      WHERE ${modelBenchmarks.tenantId} = ${tenantId}
        AND ${modelBenchmarks.id} NOT IN (
          SELECT id FROM ${modelBenchmarks}
          WHERE ${modelBenchmarks.tenantId} = ${tenantId}
          ORDER BY ${modelBenchmarks.at} DESC
          LIMIT ${BENCHMARK_RETAIN_PER_TENANT}
        )
    `);
    return id;
  }

  async ranking(tenantId: string, perModel: number): Promise<readonly BenchmarkRankingEntry[]> {
    const take = Math.min(Math.max(perModel, 1), 50);
    const rows = await this.db
      .select()
      .from(modelBenchmarks)
      .where(eq(modelBenchmarks.tenantId, tenantId))
      .orderBy(modelBenchmarks.model, desc(modelBenchmarks.at));

    const byModel = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byModel.get(row.model) ?? [];
      if (list.length < take) list.push(row);
      byModel.set(row.model, list);
    }

    const results: Omit<BenchmarkRankingEntry, "rank">[] = [];
    for (const [model, list] of byModel) {
      const okRuns = list.filter((row) => row.ok);
      const latencies = okRuns.map((row) => row.latencyMs);
      const outputs = okRuns.map((row) => row.outputTokens).filter((n): n is number => n !== null);
      const totalLatency = latencies
        .filter((n): n is number => n !== null)
        .reduce((sum, n) => sum + n, 0);
      results.push({
        model,
        provider: list.find((row) => row.provider !== null)?.provider ?? null,
        runs: list.length,
        ok: okRuns.length,
        failed: list.length - okRuns.length,
        // Median, not mean: one timeout must not move the ranking.
        medianLatencyMs: median(latencies),
        medianTtftMs: median(okRuns.map((row) => row.ttftMs)),
        tokensPerSec:
          outputs.length > 0 && totalLatency > 0
            ? Math.round((outputs.reduce((a, b) => a + b, 0) / totalLatency) * 1000)
            : null,
        lastRunAt: list[0]?.at.toISOString() ?? null,
        lastError: list.find((row) => !row.ok)?.error ?? null,
      });
    }

    // Rank only models that answered at least once, fastest median first.
    results.sort((a, b) => {
      if (a.ok === 0) return 1;
      if (b.ok === 0) return -1;
      return (a.medianLatencyMs ?? Infinity) - (b.medianLatencyMs ?? Infinity);
    });
    return results.map((entry, index) => ({ rank: entry.ok > 0 ? index + 1 : null, ...entry }));
  }

  async recent(tenantId: string, limit: number): Promise<readonly BenchmarkRecentEntry[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(modelBenchmarks)
      .where(eq(modelBenchmarks.tenantId, tenantId))
      .orderBy(desc(modelBenchmarks.at))
      .limit(safeLimit);
    return rows.map((row) => ({
      id: row.id,
      model: row.model,
      provider: row.provider,
      ok: row.ok,
      latencyMs: row.latencyMs,
      ttftMs: row.ttftMs,
      outputTokens: row.outputTokens,
      error: row.error,
      at: row.at.toISOString(),
    }));
  }
}
