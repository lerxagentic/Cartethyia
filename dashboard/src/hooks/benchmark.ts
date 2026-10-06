import { consoleRequest, isRecord } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { BenchmarkRankingEntry, BenchmarkRecentEntry } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "./common";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface BenchmarkListResult {
  readonly ranking: readonly BenchmarkRankingEntry[];
  readonly recent: readonly BenchmarkRecentEntry[];
}

export interface BenchmarkRunResult {
  readonly results: readonly {
    readonly id: string;
    readonly model: string;
    readonly ok: boolean;
    readonly latencyMs: number | null;
    readonly error: string | null;
  }[];
  readonly ranking: readonly BenchmarkRankingEntry[];
}

function assertBenchmarkList(value: unknown): BenchmarkListResult {
  if (!isRecord(value) || !Array.isArray(value.ranking) || !Array.isArray(value.recent)) {
    throw { status: 500, code: "invalid_response", message: "Invalid benchmark response" } satisfies ApiErrorShape;
  }
  return {
    ranking: value.ranking as BenchmarkRankingEntry[],
    recent: value.recent as BenchmarkRecentEntry[],
  };
}

/** Loads the stored model ranking plus the most recent runs. */
export function useBenchmark() {
  return useQuery({
    queryKey: queryKeys.benchmark.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/benchmark", { signal: querySignal(context) }).then(assertBenchmarkList),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/**
 * Runs a real completion per model and records the timing. This spends the
 * operator's provider quota, so it is an explicit action, never a background
 * refresh.
 */
export function useRunBenchmark() {
  const queryClient = useQueryClient();
  return useMutation<BenchmarkRunResult, ApiErrorShape, readonly string[]>({
    mutationFn: (models) =>
      consoleRequest<BenchmarkRunResult>("/benchmark", {
        method: "POST",
        body: JSON.stringify({ models }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.benchmark.all });
    },
  });
}
