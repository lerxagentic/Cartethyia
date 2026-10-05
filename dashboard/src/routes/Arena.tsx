import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import {
  Swords,
  Play,
  Square,
  Copy,
  Check,
  Plus,
  Trash2,
  Brain,
  Clock,
  Zap,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Textarea, Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { Select } from "../components/ui/select";
import { ModelPickerModal } from "../components/ModelPicker";
import { Markdown } from "../components/studio/markdown";
import { toast } from "../shared/toast";
import { useClipboard } from "../hooks/use-clipboard";
import { getErrorMessage } from "../shared/helpers";
import { ensureGatewayKey } from "../shared/ensure-gateway-key";
import {
  createChatStreamAccumulator,
  pumpChatStream,
  formatStudioMs,
} from "../shared/studio-stream";
import type { ChatStreamAccumulator } from "../shared/studio-stream";

const STORAGE_SLOTS_KEY = "cartethyia:arena:slots";
const STORAGE_PROMPT_KEY = "cartethyia:arena:prompt";
const MAX_SLOTS = 4;
const MIN_SLOTS = 2;

const DEFAULT_SLOTS = [
  "kiro/claude-sonnet-4.5",
  "antigravity/gemini-3.1-pro",
];

interface SlotState {
  model: string;
  loading: boolean;
  text: string;
  reasoning: string;
  ttftMs: number | null;
  totalMs: number | null;
  tokensOut: number | null;
  tokensIn: number | null;
  error: string | null;
  finishReason: string | null;
  stopped: boolean;
}

function initialSlot(model = ""): SlotState {
  return {
    model,
    loading: false,
    text: "",
    reasoning: "",
    ttftMs: null,
    totalMs: null,
    tokensOut: null,
    tokensIn: null,
    error: null,
    finishReason: null,
    stopped: false,
  };
}

export default function Arena(): ReactNode {
  const [slotModels, setSlotModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_SLOTS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= MIN_SLOTS) return parsed.slice(0, MAX_SLOTS);
      }
    } catch {}
    return DEFAULT_SLOTS;
  });

  const [prompt, setPrompt] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_PROMPT_KEY) || "";
    } catch {}
    return "";
  });

  const [systemPrompt, setSystemPrompt] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("2048");
  const [reasoningEffort, setReasoningEffort] = useState("auto");

  const [slots, setSlots] = useState<SlotState[]>(() =>
    slotModels.map((m) => initialSlot(m)),
  );

  const [pickerSlotIndex, setPickerSlotIndex] = useState<number | null>(null);
  const controllersRef = useRef<Map<number, AbortController>>(new Map());

  // Keep slots in sync when slotModels change
  useEffect(() => {
    setSlots((prev) =>
      slotModels.map((m, i) => (prev[i] ? { ...prev[i], model: m } : initialSlot(m))),
    );
    try {
      localStorage.setItem(STORAGE_SLOTS_KEY, JSON.stringify(slotModels));
    } catch {}
  }, [slotModels]);

  // Autosave prompt
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PROMPT_KEY, prompt);
    } catch {}
  }, [prompt]);

  const isAnyRunning = slots.some((s) => s.loading);

  const handleAddSlot = () => {
    if (slotModels.length >= MAX_SLOTS) return;
    setSlotModels((curr) => [...curr, ""]);
  };

  const handleRemoveSlot = (index: number) => {
    if (slotModels.length <= MIN_SLOTS) return;
    // Abort if running
    controllersRef.current.get(index)?.abort();
    controllersRef.current.delete(index);

    setSlotModels((curr) => curr.filter((_, i) => i !== index));
    setSlots((curr) => curr.filter((_, i) => i !== index));
  };

  const handleStopAll = useCallback(() => {
    for (const controller of controllersRef.current.values()) {
      controller.abort();
    }
    controllersRef.current.clear();
    setSlots((prev) =>
      prev.map((s) => (s.loading ? { ...s, loading: false, stopped: true } : s)),
    );
    toast.success("All runs stopped.");
  }, []);

  const handleStopSingle = useCallback((index: number) => {
    const c = controllersRef.current.get(index);
    if (c) {
      c.abort();
      controllersRef.current.delete(index);
      setSlots((prev) =>
        prev.map((s, i) => (i === index ? { ...s, loading: false, stopped: true } : s)),
      );
    }
  }, []);

  const handleRunBattle = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error("Please enter a prompt to compare.");
      return;
    }
    const emptySlot = slotModels.findIndex((m) => !m.trim());
    if (emptySlot !== -1) {
      toast.error(`Slot ${emptySlot + 1} has no model selected.`);
      return;
    }

    let key = "";
    try {
      key = await ensureGatewayKey();
    } catch (e) {
      toast.error(getErrorMessage(e, "Gateway authentication failed."));
      return;
    }

    // Reset results for all slots
    setSlots((prev) =>
      prev.map((s) => ({
        ...initialSlot(s.model),
        loading: true,
      })),
    );

    // Cancel any previous controllers
    for (const c of controllersRef.current.values()) c.abort();
    controllersRef.current.clear();

    // Launch each model stream independently
    slotModels.forEach((targetModel, index) => {
      const controller = new AbortController();
      controllersRef.current.set(index, controller);
      const startTime = performance.now();
      let firstTokenTime: number | null = null;

      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt.trim()) {
        messages.push({ role: "system", content: systemPrompt.trim() });
      }
      messages.push({ role: "user", content: prompt.trim() });

      const body: Record<string, unknown> = {
        model: targetModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: Number(temperature) || 0.7,
        max_tokens: Number(maxTokens) || 2048,
      };
      if (reasoningEffort !== "auto") {
        body.reasoning_effort = reasoningEffort;
      }

      void (async () => {
        try {
          const res = await fetch("/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          const acc: ChatStreamAccumulator = createChatStreamAccumulator();
          await pumpChatStream(
            res,
            acc,
            {
              onUpdate: (latest) => {
                if (firstTokenTime === null && (latest.text.length > 0 || latest.reasoning.length > 0)) {
                  firstTokenTime = performance.now();
                }
                const now = performance.now();
                setSlots((prev) =>
                  prev.map((s, i) =>
                    i === index
                      ? {
                          ...s,
                          text: latest.text,
                          reasoning: latest.reasoning,
                          ttftMs: firstTokenTime !== null ? Math.round(firstTokenTime - startTime) : null,
                          totalMs: Math.round(now - startTime),
                          tokensOut: latest.usage?.output ?? null,
                          tokensIn: latest.usage?.input ?? null,
                          finishReason: latest.finishReason ?? null,
                        }
                      : s,
                  ),
                );
              },
            },
            controller.signal,
          );

          const finalTime = performance.now();
          setSlots((prev) =>
            prev.map((s, i) =>
              i === index
                ? {
                    ...s,
                    loading: false,
                    totalMs: Math.round(finalTime - startTime),
                  }
                : s,
            ),
          );
        } catch (err: unknown) {
          const isAbort = (err as Error)?.name === "AbortError";
          const finalTime = performance.now();
          setSlots((prev) =>
            prev.map((s, i) =>
              i === index
                ? {
                    ...s,
                    loading: false,
                    stopped: isAbort,
                    error: isAbort ? null : getErrorMessage(err, "Stream failed"),
                    totalMs: Math.round(finalTime - startTime),
                  }
                : s,
            ),
          );
        } finally {
          controllersRef.current.delete(index);
        }
      })();
    });
  }, [prompt, slotModels, systemPrompt, temperature, maxTokens, reasoningEffort]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0, paddingBottom: "32px" }}>
      {/* Top Banner / Card */}
      <Card>
        <CardHeader
          title="Compare Models (Arena)"
          subtitle="Battle multiple models side-by-side with real-time streaming, latency breakdown, and reasoning evaluation"
          icon={<Swords size={18} />}
        />
        <CardBody>
          <Stack gap="14px">
            {/* Prompt Input Area */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                Benchmark Prompt
              </label>
              <Textarea
                placeholder="Enter prompt to evaluate across models simultaneously (e.g. coding puzzle, analysis, creative task)..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isAnyRunning}
                style={{
                  minHeight: "100px",
                  fontSize: "13px",
                  lineHeight: 1.6,
                }}
              />
            </div>

            {/* Collapsible Options Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button
                type="button"
                onClick={() => setShowOptions(!showOptions)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <SlidersHorizontal size={13} />
                Parameters & System Prompt
                {showOptions ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            </div>

            {/* Expanded Options */}
            {showOptions ? (
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "var(--surface-muted)",
                  border: "1px solid var(--inner-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div>
                  <label style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text-secondary)" }}>
                    System Prompt (Optional)
                  </label>
                  <Textarea
                    placeholder="Instructions applied to all models equally..."
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    disabled={isAnyRunning}
                    style={{ minHeight: "60px", fontSize: "12px", marginTop: "4px" }}
                  />
                </div>
                <Inline gap="14px" style={{ flexWrap: "wrap" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "120px" }}>
                    <label style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Temperature</label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={temperature}
                      onChange={(e) => setTemperature(e.target.value)}
                      disabled={isAnyRunning}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "120px" }}>
                    <label style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Max Tokens</label>
                    <Input
                      type="number"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(e.target.value)}
                      disabled={isAnyRunning}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "140px" }}>
                    <label style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Reasoning Effort</label>
                    <Select
                      id="arena-reasoning"
                      value={reasoningEffort}
                      onValueChange={(val) => setReasoningEffort(val)}
                      disabled={isAnyRunning}
                      options={[
                        { value: "auto", label: "Auto / Default" },
                        { value: "minimal", label: "Minimal" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                      ]}
                    />
                  </div>
                </Inline>
              </div>
            ) : null}

            {/* Execution Bar */}
            <Inline gap="10px" style={{ alignItems: "center", justifyContent: "space-between" }}>
              <Inline gap="8px">
                {isAnyRunning ? (
                  <Button variant="danger" size="sm" onClick={handleStopAll}>
                    <Square size={14} /> Stop all streams
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={handleRunBattle} disabled={!prompt.trim()}>
                    <Play size={14} /> Compare ({slots.length} models)
                  </Button>
                )}
                {slots.length < MAX_SLOTS ? (
                  <Button variant="secondary" size="sm" onClick={handleAddSlot} disabled={isAnyRunning}>
                    <Plus size={14} /> Add contender
                  </Button>
                ) : null}
              </Inline>
              <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
                {slots.length} / {MAX_SLOTS} models active
              </span>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {/* Arena Grid: 2, 3, or 4 equal columns */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${slots.length <= 2 ? 2 : slots.length === 3 ? 3 : 4}, minmax(0, 1fr))`,
          gap: "14px",
          alignItems: "stretch",
        }}
      >
        {slots.map((slot, index) => (
          <ArenaModelCard
            key={index}
            index={index}
            slot={slot}
            canRemove={slots.length > MIN_SLOTS}
            onSelectModel={() => setPickerSlotIndex(index)}
            onRemove={() => handleRemoveSlot(index)}
            onStop={() => handleStopSingle(index)}
          />
        ))}
      </div>

      {/* Model Picker Modal */}
      {pickerSlotIndex !== null ? (
        <ModelPickerModal
          open={pickerSlotIndex !== null}
          onClose={() => setPickerSlotIndex(null)}
          selected={slotModels[pickerSlotIndex] ? [slotModels[pickerSlotIndex]] : []}
          multi={false}
          onToggle={() => {}}
          onSelectOne={(picked) => {
            setSlotModels((curr) => curr.map((m, i) => (i === pickerSlotIndex ? picked : m)));
            setPickerSlotIndex(null);
          }}
          title={`Select Contender #${pickerSlotIndex + 1}`}
        />
      ) : null}
    </div>
  );
}

function ArenaModelCard({
  index,
  slot,
  canRemove,
  onSelectModel,
  onRemove,
  onStop,
}: {
  index: number;
  slot: SlotState;
  canRemove: boolean;
  onSelectModel: () => void;
  onRemove: () => void;
  onStop: () => void;
}): ReactNode {
  const { copied, copy } = useClipboard();
  const [showThinking, setShowThinking] = useState(false);

  const provider = slot.model.includes("/") ? slot.model.split("/")[0] : null;
  const modelName = slot.model.includes("/") ? slot.model.split("/").slice(1).join("/") : slot.model;

  // Tok/s calculation
  const tokPerSec =
    slot.totalMs && slot.tokensOut && slot.totalMs > 0
      ? ((slot.tokensOut / (slot.totalMs / 1000))).toFixed(1)
      : null;

  return (
    <Card style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: "420px" }}>
      {/* Card Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--inner-border)",
          background: "var(--surface-muted)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: "var(--text-tertiary)",
                background: "var(--surface-primary)",
                padding: "2px 6px",
                borderRadius: "4px",
              }}
            >
              #{index + 1}
            </span>
            <button
              type="button"
              onClick={onSelectModel}
              disabled={slot.loading}
              title="Click to change model"
              style={{
                background: "transparent",
                border: "none",
                textAlign: "left",
                padding: 0,
                cursor: slot.loading ? "default" : "pointer",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: "12.5px", fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {modelName || "Pick a model"}
              </div>
              {provider ? (
                <div style={{ fontSize: "10.5px", color: "var(--text-tertiary)" }}>{provider}</div>
              ) : null}
            </button>
          </div>
          <Inline gap="4px">
            {slot.loading ? (
              <Button variant="danger" size="sm" onClick={onStop} title="Stop this stream">
                <Square size={12} />
              </Button>
            ) : null}
            {canRemove && !slot.loading ? (
              <Button variant="secondary" size="sm" onClick={onRemove} title="Remove contender">
                <Trash2 size={12} />
              </Button>
            ) : null}
          </Inline>
        </div>

        {/* Live Metrics Ribbon */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", fontSize: "11px" }}>
          {slot.loading ? (
            <Badge tone="warn" dot>
              Streaming
            </Badge>
          ) : slot.stopped ? (
            <Badge tone="default">Stopped</Badge>
          ) : slot.error ? (
            <Badge tone="err">Error</Badge>
          ) : slot.text ? (
            <Badge tone="ok">Done</Badge>
          ) : (
            <Badge tone="default">Idle</Badge>
          )}

          {slot.ttftMs !== null ? (
            <span title="Time To First Token" style={{ color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
              <Zap size={11} color="var(--accent)" /> {slot.ttftMs}ms
            </span>
          ) : null}

          {slot.totalMs !== null ? (
            <span title="Total duration" style={{ color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
              <Clock size={11} /> {formatStudioMs(slot.totalMs)}
            </span>
          ) : null}

          {tokPerSec !== null ? (
            <span title="Speed" style={{ color: "var(--text-tertiary)" }}>
              {tokPerSec} tok/s
            </span>
          ) : null}

          {slot.tokensOut !== null ? (
            <span title="Output tokens" style={{ color: "var(--text-tertiary)" }}>
              {slot.tokensOut} tok
            </span>
          ) : null}
        </div>
      </div>

      {/* Card Body - Content & Reasoning */}
      <CardBody style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px", padding: "12px 14px", overflowY: "auto" }}>
        {slot.error ? (
          <div
            style={{
              padding: "10px",
              borderRadius: "6px",
              background: "var(--red-soft)",
              border: "1px solid var(--red)",
              color: "var(--red)",
              fontSize: "12px",
              lineHeight: 1.5,
            }}
          >
            {slot.error}
          </div>
        ) : null}

        {/* Reasoning / Thinking Accordion */}
        {slot.reasoning ? (
          <div
            style={{
              borderRadius: "6px",
              border: "1px solid var(--inner-border)",
              background: "var(--surface-muted)",
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => setShowThinking(!showThinking)}
              style={{
                width: "100%",
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "transparent",
                border: "none",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <Inline gap="5px" style={{ alignItems: "center" }}>
                <Brain size={12} color="var(--accent)" />
                Thinking Process ({slot.reasoning.length} chars)
              </Inline>
              {showThinking ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showThinking ? (
              <div
                style={{
                  padding: "8px 10px",
                  fontSize: "11.5px",
                  color: "var(--text-tertiary)",
                  lineHeight: 1.5,
                  maxHeight: "160px",
                  overflowY: "auto",
                  borderTop: "1px solid var(--inner-border)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {slot.reasoning}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Text output */}
        <div style={{ flex: 1, minHeight: "140px", fontSize: "13px", lineHeight: 1.65 }}>
          {slot.text ? (
            <Markdown text={slot.text} />
          ) : slot.loading ? (
            <div style={{ color: "var(--text-tertiary)", fontStyle: "italic", fontSize: "12.5px" }}>
              Waiting for stream…
            </div>
          ) : (
            <div style={{ color: "var(--text-tertiary)", fontSize: "12.5px" }}>
              No output yet. Click &quot;Compare&quot; above to run.
            </div>
          )}
        </div>

        {/* Card Footer / Copy Action */}
        {slot.text ? (
          <div style={{ paddingTop: "8px", borderTop: "1px solid var(--inner-border)", display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const ok = await copy(slot.text);
                if (ok) toast.success("Output copied.");
                else toast.error("Copy failed.");
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
