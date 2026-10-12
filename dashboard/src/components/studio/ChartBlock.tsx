/**
 * Chart rendering for the Model Lab transcript.
 *
 * `recharts` is already a dependency (the Usage page uses it), so a chart costs
 * no new bundle weight and matches the console's existing visual language. The
 * component is still imported lazily from the markdown renderer so a transcript
 * with no chart never evaluates the charting graph.
 *
 * The payload is a JSON document inside a ```chart fence, produced by the
 * `render_chart` tool. It is model-authored, so every field is validated here:
 * a malformed chart degrades to a readable error instead of crashing the
 * transcript, and a label/value length mismatch is refused rather than plotted
 * against the wrong axis.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/** One parsed chart payload. */
interface ChartSpec {
  readonly type: "bar" | "line" | "pie";
  readonly title: string;
  readonly labels: readonly string[];
  readonly values: readonly number[];
}

const PIE_COLORS = [
  "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
  "#ec4899", "#14b8a6", "#eab308", "#6366f1", "#84cc16",
];

/** Parses the fence body, returning an error string when it is unusable. */
export function parseChartSpec(source: string): ChartSpec | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: "chart payload is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "chart payload must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const labels = record["labels"];
  const values = record["values"];
  if (!Array.isArray(labels) || !Array.isArray(values)) {
    return { error: "chart requires labels[] and values[]" };
  }
  if (labels.length === 0 || labels.length !== values.length) {
    return { error: "labels and values must be non-empty and the same length" };
  }
  const numbers = values.map((v) => (typeof v === "number" ? v : Number(v)));
  if (numbers.some((n) => !Number.isFinite(n))) return { error: "every value must be a number" };
  const type = record["type"];
  return {
    type: type === "line" || type === "pie" ? type : "bar",
    title: typeof record["title"] === "string" ? record["title"] : "",
    labels: labels.map(String),
    values: numbers,
  };
}

/** Renders one chart from a ```chart fence. */
export function ChartBlock({ source }: { source: string }): ReactNode {
  const spec = parseChartSpec(source);
  if ("error" in spec) {
    return (
      <pre
        style={{
          background: "var(--code-surface)",
          border: "1px solid var(--inner-border)",
          borderRadius: "8px",
          padding: "10px 12px",
          overflowX: "auto",
          fontSize: "11.5px",
          margin: "0 0 8px",
        }}
      >
        <div style={{ color: "var(--status-danger, #ef4444)", marginBottom: "4px", fontSize: "10.5px" }}>
          chart could not be drawn — {spec.error}
        </div>
        {source}
      </pre>
    );
  }

  const data = spec.labels.map((label, index) => ({ label, value: spec.values[index] ?? 0 }));
  const axisStyle = { fontSize: 10, fill: "var(--text-tertiary)" } as const;

  return (
    <div
      style={{
        background: "var(--code-surface)",
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        padding: "12px",
        margin: "0 0 8px",
      }}
    >
      {spec.title.length > 0 ? (
        <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "8px", color: "var(--text-primary)" }}>
          {spec.title}
        </div>
      ) : null}
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "line" ? (
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axisStyle} stroke="var(--inner-border)" />
              <YAxis tick={axisStyle} stroke="var(--inner-border)" />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--inner-border)", fontSize: 11 }}
              />
              <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          ) : spec.type === "pie" ? (
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="label" outerRadius={90} label>
                {data.map((entry, index) => (
                  <Cell key={entry.label} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--inner-border)", fontSize: 11 }}
              />
            </PieChart>
          ) : (
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axisStyle} stroke="var(--inner-border)" />
              <YAxis tick={axisStyle} stroke="var(--inner-border)" />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--inner-border)", fontSize: 11 }}
              />
              <Bar dataKey="value" fill="#3b82f6" radius={[3, 3, 0, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
