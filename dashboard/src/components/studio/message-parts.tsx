import { useState } from "react";
import type { ReactNode } from "react";
import { Bot, Brain, Check, ChevronDown, Copy, User, Wrench } from "lucide-react";
import type { StudioMessage } from "../../data/contracts";
import { formatStudioMs } from "../../shared/studio-stream";
import { formatTokens as formatTokenCount } from "../../shared/format";
import { toast } from "../../shared/toast";
import { useClipboard } from "../../hooks/use-clipboard";

function formatTokens(usage: StudioMessage["usage"]): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`in ${formatTokenCount(usage.input)}`);
  if (usage.output !== undefined) parts.push(`out ${formatTokenCount(usage.output)}`);
  if (usage.reasoning !== undefined) parts.push(`think ${formatTokenCount(usage.reasoning)}`);
  if (usage.cached !== undefined) parts.push(`cached ${formatTokenCount(usage.cached)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function Thinking({ reasoning, streaming }: { reasoning: string; streaming: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  if (streaming) {
    if (!reasoning) return null;
    return (
      <div style={{ marginBottom: "8px", marginTop: "4px" }} aria-live="polite">
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            background: "var(--surface-muted)",
            padding: "8px 12px",
            borderRadius: "12px",
          }}
        >
          {reasoning}
        </div>
      </div>
    );
  }
  if (!reasoning) return null;
  return (
    <div style={{ marginBottom: "8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          border: "none",
          borderRadius: "9999px",
          background: "var(--surface-muted)",
          color: "var(--text-secondary)",
          fontSize: "10.5px",
          fontWeight: 600,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        <Brain size={12} /> {open ? "Hide thinking" : "Show thinking"}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <div
          style={{
            marginTop: "6px",
            padding: "8px 12px",
            background: "var(--surface-muted)",
            borderRadius: "12px",
            color: "var(--text-secondary)",
            fontSize: "12px",
            fontStyle: "italic",
            whiteSpace: "pre-wrap",
          }}
        >
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}

export function ToolChips({ message }: { message: StudioMessage }): ReactNode {
  const [open, setOpen] = useState(false);
  const calls = message.toolRounds?.flatMap((round) => round.toolCalls) ?? [];
  if (calls.length === 0) return null;
  return (
    <div style={{ marginBottom: "8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          border: "1px solid var(--inner-border)",
          borderRadius: "9999px",
          background: "var(--surface-muted)",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 600,
          padding: "3px 10px",
          cursor: "pointer",
        }}
      >
        <Wrench size={11} /> {calls.length} tool call{calls.length === 1 ? "" : "s"}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {calls.map((call, index) => (
            <ToolCallCard key={`${call.name}-${index}`} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One tool call: name, arguments, and the result.
 *
 * Long results are collapsed to a scrollable block rather than dumped inline —
 * a `web_fetch` can return tens of thousands of characters, and rendering that
 * unbounded would push the conversation off screen. */
function ToolCallCard({
  call,
}: {
  call: { name: string; args: string; result: string };
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const RESULT_PREVIEW = 400;
  const long = call.result.length > RESULT_PREVIEW;
  const shown = !long || expanded ? call.result : `${call.result.slice(0, RESULT_PREVIEW)}…`;
  const failed = /"error"\s*:/.test(call.result);
  return (
    <div
      style={{
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        background: "var(--code-surface)",
        padding: "8px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{call.name}</div>
      <div style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>→ {call.args}</div>
      <div
        style={{
          color: failed ? "var(--status-danger, #ef4444)" : "var(--status-success)",
          wordBreak: "break-all",
          whiteSpace: "pre-wrap",
          maxHeight: expanded ? "40vh" : undefined,
          overflowY: expanded && long ? "auto" : undefined,
        }}
      >
        ← {shown}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: "4px",
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--accent)",
            fontSize: "10px",
            cursor: "pointer",
          }}
        >
          {expanded ? "show less" : `show all ${call.result.length} chars`}
        </button>
      ) : null}
    </div>
  );
}

/** Live view of tool calls while a turn is still streaming.
 *
 * The transcript only gets its tool cards once the turn finishes, so without
 * this the user watches "running web_search…" with no sight of the arguments the
 * model chose or the result coming back. This renders each call as it starts and
 * updates in place as its result lands. */
export function LiveToolCalls({
  calls,
}: {
  calls: readonly { name: string; args: string; result?: string; running: boolean }[];
}): ReactNode {
  if (calls.length === 0) return null;
  return (
    <div style={{ marginBottom: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
      {calls.map((call, index) => (
        <div
          key={`${call.name}-${index}`}
          style={{
            border: "1px solid var(--inner-border)",
            borderRadius: "8px",
            background: "var(--code-surface)",
            padding: "8px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, color: "var(--text-primary)" }}>
            {call.running ? <span className="mlab-live-dot" /> : <Check size={11} />}
            {call.name}
          </div>
          <div style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>→ {call.args}</div>
          {call.result !== undefined ? (
            <div style={{ color: "var(--status-success)", wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
              ← {call.result.length > 400 ? `${call.result.slice(0, 400)}…` : call.result}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function MessageMeta({ message }: { message: StudioMessage }): ReactNode {
  const tokens = formatTokens(message.usage);
  if (!tokens && message.ttfbMs === undefined && message.completionMs === undefined) return null;
  const times = [
    message.ttfbMs === undefined ? null : `ttfb ${formatStudioMs(message.ttfbMs)}`,
    message.completionMs === undefined ? null : `total ${formatStudioMs(message.completionMs)}`,
  ].filter((part): part is string => part !== null);
  const detail = [...(tokens ? [tokens] : []), ...times].join(" · ");
  return (
    <div
      title={detail}
      style={{
        marginTop: "6px",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        color: "var(--text-tertiary)",
      }}
    >
      {detail}
    </div>
  );
}

export function Avatar({ kind }: { kind: "user" | "assistant" }): ReactNode {
  const Icon = kind === "user" ? User : Bot;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: "26px",
        height: "26px",
        borderRadius: "9999px",
        flexShrink: 0,
        background: kind === "user" ? "var(--accent-soft)" : "var(--surface-muted)",
        color: kind === "user" ? "var(--accent)" : "var(--text-secondary)",
        border: "1px solid var(--inner-border)",
      }}
    >
      <Icon size={13} />
    </span>
  );
}

export function CopyButton({ text }: { text: string }): ReactNode {
  const { copied, copy } = useClipboard();
  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={() => {
        void copy(text).then((ok) => {
          if (!ok) toast.error("Copy failed");
        });
      }}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: copied ? "var(--status-success)" : "var(--text-tertiary)",
        padding: "2px",
        display: "inline-flex",
        opacity: copied ? 1 : 0.55,
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
