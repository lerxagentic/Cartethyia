import { useMemo, useState } from "react";
import { Gauge, Plus, Trash2, Play, Trophy } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/page-header";
import { ModelPickerModal } from "../components/ModelPicker";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
import { useBenchmark, useRunBenchmark } from "../hooks/benchmark";
import type { BenchmarkRankingEntry } from "../data/contracts";

const MAX_MODELS = 10;

function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

/**
 * Model Benchmark — a speed ranking built from stored runs.
 *
 * Ranking is by median latency over the most recent runs per model, not the
 * newest single run: one timeout or a warm cache would otherwise decide the
 * order. Only models that answered at least once get a rank; failures stay in
 * the table so a model that is down is visible rather than quietly missing.
 *
 * Running spends the operator's own provider quota — one real completion per
 * model — so it is always an explicit button, never a background refresh.
 */
export default function Benchmark(): React.ReactNode {
  const benchmark = useBenchmark();
  const runBenchmark = useRunBenchmark();
  const [models, setModels] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [progress, setProgress] = useState("");

  const ranking = benchmark.data?.ranking ?? [];
  const recent = benchmark.data?.recent ?? [];
  const slowest = useMemo(
    () => ranking.reduce((max, row) => Math.max(max, row.medianLatencyMs ?? 0), 0) || 1,
    [ranking],
  );

  function addModel(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || models.includes(trimmed) || models.length >= MAX_MODELS) return;
    setModels((previous) => [...previous, trimmed]);
  }

  async function run(): Promise<void> {
    if (models.length === 0) return;
    setProgress(`Running ${models.length} model${models.length === 1 ? "" : "s"}…`);
    try {
      const result = await runBenchmark.mutateAsync(models);
      const ok = result.results.filter((entry) => entry.ok).length;
      const failed = result.results.length - ok;
      setProgress(
        failed > 0
          ? `Done: ${ok} responded, ${failed} failed. Failures stay in the table.`
          : "Done.",
      );
      toast.success("Benchmark complete", `${ok} of ${result.results.length} models responded.`);
    } catch (error) {
      setProgress("");
      toast.error("Benchmark failed", getErrorMessage(error));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Model Benchmark"
        description="Sends one real request per model through this router and records latency. Uses your provider quota."
        icon={<Gauge size={18} />}
        badges={<Badge tone="default">{ranking.length} ranked</Badge>}
      />

      <Card>
        <CardHeader
          title="Benchmark models"
          subtitle={`Up to ${MAX_MODELS} per run. Ranking uses the median of the last runs, so one slow sample cannot decide the order.`}
          action={
            <Button
              onClick={() => void run()}
              disabled={models.length === 0 || runBenchmark.isPending}
              loading={runBenchmark.isPending}
              icon={<Play size={14} />}
            >
              Run benchmark
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            {models.map((model, index) => (
              <div key={model} className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-center text-[10px] font-semibold text-text-muted">
                  {index + 1}
                </span>
                <Input value={model} readOnly className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  label="Remove"
                  onClick={() => setModels((previous) => previous.filter((entry) => entry !== model))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            {models.length < MAX_MODELS ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => setPickerOpen(true)}>
                  Pick model
                </Button>
                <Input
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      addModel(manual);
                      setManual("");
                    }
                  }}
                  placeholder="or type provider/model and press Enter"
                  className="flex-1"
                />
              </div>
            ) : null}
          </div>
          {progress ? <p className="text-xs text-text-muted">{progress}</p> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Ranking" subtitle="Fastest median latency first. Models that never answered are unranked." />
        <CardBody>
          {benchmark.isLoading ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : ranking.length === 0 ? (
            <p className="text-sm text-text-muted">No benchmark runs yet. Pick models above and run one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-text-muted">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Model</th>
                    <th className="py-2 pr-3">Median latency</th>
                    <th className="py-2 pr-3">Median TTFT</th>
                    <th className="py-2 pr-3">Tok/s</th>
                    <th className="py-2 pr-3">OK / Failed</th>
                    <th className="py-2 pr-3">Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((row: BenchmarkRankingEntry) => (
                    <tr key={row.model} className="border-t border-border-subtle">
                      <td className="py-2 pr-3">
                        {row.rank === 1 ? (
                          <span className="inline-flex items-center gap-1 text-amber-500">
                            <Trophy size={13} /> 1
                          </span>
                        ) : (
                          (row.rank ?? "—")
                        )}
                      </td>
                      <td className="py-2 pr-3 font-medium text-text-main">{row.model}</td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{ms(row.medianLatencyMs)}</span>
                          <span
                            className="h-1.5 rounded-full bg-accent"
                            style={{
                              width: `${Math.max(4, Math.round(((row.medianLatencyMs ?? 0) / slowest) * 64))}px`,
                              opacity: row.ok > 0 ? 0.9 : 0.3,
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{ms(row.medianTtftMs)}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.tokensPerSec ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <span className="text-emerald-500">{row.ok}</span>
                        <span className="text-text-muted"> / </span>
                        <span className={row.failed > 0 ? "text-red-500" : "text-text-muted"}>{row.failed}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-text-muted">
                        {row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent runs" subtitle="Most recent 50 samples, newest first." />
        <CardBody>
          {recent.length === 0 ? (
            <p className="text-sm text-text-muted">No runs recorded.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {recent.slice(0, 25).map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-center gap-3 text-xs">
                  <Badge tone={entry.ok ? "ok" : "err"}>{entry.ok ? "OK" : "FAIL"}</Badge>
                  <span className="font-medium text-text-main">{entry.model}</span>
                  <span className="tabular-nums text-text-muted">{ms(entry.latencyMs)}</span>
                  <span className="text-text-muted">{new Date(entry.at).toLocaleTimeString()}</span>
                  {entry.error ? <span className="text-red-500">{entry.error}</span> : null}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <ModelPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={[]}
        multi={false}
        onToggle={() => {}}
        onSelectOne={(picked: string) => {
          addModel(picked);
          setPickerOpen(false);
        }}
        title="Add a model to benchmark"
      />
    </div>
  );
}
