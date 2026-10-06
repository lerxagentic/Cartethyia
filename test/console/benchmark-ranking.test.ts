/**
 * Model benchmark ranking.
 *
 * The ranking exists to answer "which model is fastest here" without letting a
 * single sample decide it: the figure is the MEDIAN over the most recent runs,
 * so one timeout or one warm-cache outlier cannot reorder the table. Models
 * that never answered are unranked but still listed, so a down model is visible
 * rather than quietly missing.
 *
 * The store is exercised through a fake Drizzle-shaped database so the ranking
 * arithmetic is pinned without a live Postgres.
 */
import { describe, expect, test } from "bun:test";
import { DrizzleBenchmarkStore } from "../../src/console/domains/benchmark/store";

interface Row {
  id: string;
  tenantId: string;
  model: string;
  provider: string | null;
  ok: boolean;
  latencyMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  error: string | null;
  at: Date;
}

/**
 * Minimal stand-in for the two Drizzle entry points the store uses: a
 * chainable select/insert builder. The select path reproduces the store's own
 * `orderBy(model ASC, at DESC)` so a test can rely on the window being taken
 * from the newest runs first, exactly as Postgres would.
 */
function fakeDb(rows: Row[]) {
  const state = { rows: [...rows] };
  const ordered = () =>
    [...state.rows].sort((a, b) =>
      a.model === b.model ? b.at.getTime() - a.at.getTime() : a.model < b.model ? -1 : 1,
    );
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(ordered()),
          limit: (n: number) => Promise.resolve(ordered().slice(0, n)),
        }),
      }),
    }),
    insert: () => ({ values: (value: Row) => { state.rows.push(value); return Promise.resolve(); } }),
    execute: () => Promise.resolve(),
  };
  return { db: db as never, state };
}

function run(partial: Partial<Row>): Row {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    tenantId: "t1",
    model: partial.model ?? "m",
    provider: partial.provider ?? null,
    ok: partial.ok ?? true,
    // `in`-checks, not `??`: an explicit `null` (a run that reported no token
    // count) must survive, and `??` would silently replace it with the default.
    latencyMs: "latencyMs" in partial ? (partial.latencyMs ?? null) : 100,
    ttftMs: "ttftMs" in partial ? (partial.ttftMs ?? null) : 50,
    outputTokens: "outputTokens" in partial ? (partial.outputTokens ?? null) : 10,
    error: partial.error ?? null,
    at: partial.at ?? new Date(),
  };
}

describe("benchmark ranking", () => {
  test("ranks by median latency, not by a single slow sample", async () => {
    const { db } = fakeDb([
      // "fast" is consistently quick but has one outlier.
      run({ model: "fast", latencyMs: 100 }),
      run({ model: "fast", latencyMs: 110 }),
      run({ model: "fast", latencyMs: 9000 }),
      // "slow" is consistently slower.
      run({ model: "slow", latencyMs: 300 }),
      run({ model: "slow", latencyMs: 320 }),
      run({ model: "slow", latencyMs: 310 }),
    ]);
    const store = new DrizzleBenchmarkStore(db);
    const ranking = await store.ranking("t1", 10);
    // Median of fast (110) beats median of slow (310) despite the 9 s outlier.
    expect(ranking.map((entry) => entry.model)).toEqual(["fast", "slow"]);
    expect(ranking[0]!.rank).toBe(1);
    expect(ranking[0]!.medianLatencyMs).toBe(110);
    expect(ranking[1]!.medianLatencyMs).toBe(310);
  });

  test("a model that never answered is listed but unranked", async () => {
    const { db } = fakeDb([
      run({ model: "ok-model", latencyMs: 100 }),
      run({ model: "down-model", ok: false, latencyMs: null, error: "HTTP 500" }),
    ]);
    const store = new DrizzleBenchmarkStore(db);
    const ranking = await store.ranking("t1", 10);
    const down = ranking.find((entry) => entry.model === "down-model");
    expect(down, "down model missing from the table").toBeDefined();
    expect(down!.rank).toBeNull();
    expect(down!.failed).toBe(1);
    expect(down!.lastError).toBe("HTTP 500");
  });

  test("only the most recent runs per model feed the ranking", async () => {
    const rows: Row[] = [];
    // 12 runs: the first two are very slow, the last ten fast. With a window of
    // 10 the slow pair must not be counted.
    for (let i = 0; i < 12; i++) {
      rows.push(
        run({
          model: "m",
          latencyMs: i < 2 ? 5000 : 100,
          at: new Date(2026, 0, 1, 0, i),
        }),
      );
    }
    const { db } = fakeDb(rows);
    const store = new DrizzleBenchmarkStore(db);
    const ranking = await store.ranking("t1", 10);
    expect(ranking[0]!.medianLatencyMs).toBe(100);
  });

  test("tokens/sec is null when no run reported a token count", async () => {
    const { db } = fakeDb([run({ model: "m", latencyMs: 1000, outputTokens: null })]);
    const store = new DrizzleBenchmarkStore(db);
    const ranking = await store.ranking("t1", 10);
    expect(ranking[0]!.tokensPerSec).toBeNull();
  });
});
