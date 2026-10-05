import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import {
  FileText,
  Play,
  Square,
  Copy,
  Check,
  Download,
  Trash2,
  Sparkles,
  Edit3,
  Eye,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { ModelPickerModal } from "../components/ModelPicker";
import { Markdown } from "../components/studio/markdown";
import { toast } from "../shared/toast";
import { useClipboard } from "../hooks/use-clipboard";
import { downloadTextFile } from "../shared/download";
import { getErrorMessage } from "../shared/helpers";
import { ensureGatewayKey } from "../shared/ensure-gateway-key";
import { createChatStreamAccumulator, pumpChatStream } from "../shared/studio-stream";

const STORAGE_KEY = "cartethyia:prd-builder:draft";

export function buildPrdPrompt(prompt: string): string {
  return [
    "You are an expert product manager and technical architect writing a complete PRD (Product Requirements Document) in one pass.",
    "",
    "Request from the user:",
    prompt.trim() || "(no request given)",
    "",
    "Cover these sections, in this order, using Markdown headings:",
    "## 1. Overview",
    "What is being built, the core value proposition, and why it matters now.",
    "",
    "## 2. Problem & Background",
    "Who hits this problem, how frequently, and what workarounds they use today.",
    "",
    "## 3. Target Users & User Personas",
    "Primary and secondary personas, their context, and their pain points.",
    "",
    "## 4. Goals & Non-Goals",
    "- **Goals**: 3-5 measurable, realistic outcomes.",
    "- **Non-Goals**: Explicitly out of scope for v1, with a one-line reason each.",
    "",
    "## 5. Functional Requirements & Features",
    "Each feature formatted as a clear bullet with priority tag: `[Must Have]`, `[Should Have]`, or `[Nice to Have]`.",
    "",
    "## 6. Technical Architecture & Constraints",
    "Platform, data models, API contracts, security requirements, and scalability considerations.",
    "",
    "## 7. Success Criteria & Verification Checklist",
    "A checklist of verifiable items that someone else can validate without ambiguity.",
    "",
    "## 8. Risks, Assumptions & Open Questions",
    "What could block implementation, key dependencies, and decisions that still need validation.",
    "",
    "- Complete ALL 8 sections thoroughly without stopping early or truncating tables.",
    "- Rules:",
    "- Write section titles and body in the same language as the user's request (e.g. Indonesian if the prompt is in Indonesian, English if English).",
    "- No conversational filler, pleasantries, or closing summary. Start immediately with Section 1.",
    "- Where details are unspecified, do not fabricate them; place them under Section 8 as Open Questions.",
    "- Output clean, professional Markdown with bullet points, emphasis, and tables where suitable.",
  ].join("\n");
}

const EXAMPLE_PROMPTS = [
  {
    label: "Telegram Quota Alert Bot",
    text: "A Telegram bot for Cartethyia AI gateway that monitors multi-account provider quota and balances, alerts me when quota reaches <10%, and generates daily usage summaries.",
  },
  {
    label: "AI Multi-Provider Fallback Router",
    text: "An intelligent AI API proxy with automatic failover, latency tracking, retry backoff, and weighted round-robin between Claude, OpenAI, and Grok endpoints.",
  },
  {
    label: "Developer Task & PRD Tracker",
    text: "A self-hosted developer dashboard for tracking feature tasks, PR reviews, automated CI verification, and exporting release notes to GitHub.",
  },
];

export default function PrdBuilder(): ReactNode {
  const [model, setModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved).model || "kiro/claude-sonnet-4.5";
    } catch {}
    return "kiro/claude-sonnet-4.5";
  });

  const [prompt, setPrompt] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved).prompt || "";
    } catch {}
    return "";
  });

  const [document, setDocument] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved).document || "";
    } catch {}
    return "";
  });

  const [generating, setGenerating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");
  const [wasTruncated, setWasTruncated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { copied, copy } = useClipboard();

  // Autosave draft to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ model, prompt, document }));
    } catch {}
  }, [model, prompt, document]);

  const handleGenerate = useCallback(async () => {
    if (!model.trim()) {
      toast.error("Please pick a model first.");
      return;
    }
    if (!prompt.trim()) {
      toast.error("Please describe what you want to build.");
      return;
    }

    setGenerating(true);
    setViewMode("preview");
    setDocument("");
    setWasTruncated(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const key = await ensureGatewayKey();
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: buildPrdPrompt(prompt) }],
          stream: true,
          temperature: 0.7,
          max_tokens: 16384,
        }),
        signal: controller.signal,
      });

      const acc = createChatStreamAccumulator();
      await pumpChatStream(
        res,
        acc,
        {
          onUpdate: (latest) => {
            setDocument(latest.text);
            if (latest.finishReason === "length") {
              setWasTruncated(true);
            }
          },
        },
        controller.signal,
      );
      if (acc.finishReason === "length") {
        setWasTruncated(true);
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        toast.success("PRD generation stopped.");
      } else {
        toast.error(getErrorMessage(err, "Failed to generate PRD."));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }, [model, prompt]);

  const handleContinue = useCallback(async () => {
    if (!document.trim()) return;
    setGenerating(true);
    setWasTruncated(false);

    const controller = new AbortController();
    abortRef.current = controller;
    const baseDoc = document;

    try {
      const key = await ensureGatewayKey();
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "user", content: buildPrdPrompt(prompt) },
            { role: "assistant", content: baseDoc },
            {
              role: "user",
              content:
                "Please continue writing the remaining sections of this PRD document from where it stopped. Do not repeat the sections already written above; start immediately with the next unfinished section or row.",
            },
          ],
          stream: true,
          temperature: 0.7,
          max_tokens: 16384,
        }),
        signal: controller.signal,
      });

      const acc = createChatStreamAccumulator();
      await pumpChatStream(
        res,
        acc,
        {
          onUpdate: (latest) => {
            setDocument(baseDoc + (latest.text ? "\n\n" + latest.text : ""));
            if (latest.finishReason === "length") {
              setWasTruncated(true);
            }
          },
        },
        controller.signal,
      );
      if (acc.finishReason === "length") {
        setWasTruncated(true);
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        toast.success("PRD continuation stopped.");
      } else {
        toast.error(getErrorMessage(err, "Failed to continue PRD generation."));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }, [model, prompt, document]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    setPrompt("");
    setDocument("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    toast.success("Draft cleared.");
  }, []);

  const handleDownload = useCallback(() => {
    if (!document.trim()) return;
    const slug =
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .slice(0, 6)
        .join("-") || "prd";
    const filename = `${slug}-${new Date().toISOString().slice(0, 10)}.md`;
    downloadTextFile(filename, document, "text/markdown; charset=utf-8");
    toast.success("PRD downloaded.");
  }, [prompt, document]);

  const handleCopy = useCallback(async () => {
    if (!document.trim()) return;
    const ok = await copy(document);
    if (ok) toast.success("Copied to clipboard.");
    else toast.error("Copy failed.");
  }, [copy, document]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0, paddingBottom: "32px" }}>
      {/* Top Banner / Card */}
      <Card>
        <CardHeader
          title="PRD Builder"
          subtitle="Generate complete, structured Product Requirements Documents from a single prompt in one pass"
          icon={<FileText size={18} />}
        />
        <CardBody>
          <Stack gap="14px">
            {/* Model Selector Bar */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "12px 14px",
                borderRadius: "10px",
                background: "var(--surface-muted)",
                border: "1px solid var(--inner-border)",
              }}
            >
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" }}>
                  Selected Model
                </span>
                <Inline gap="8px" style={{ alignItems: "center" }}>
                  <span style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {model || "No model selected"}
                  </span>
                  <Badge tone="default">Default</Badge>
                </Inline>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowPicker(true)}
                disabled={generating}
              >
                Change model
              </Button>
            </div>

            {/* Prompt Input */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                What do you want to build?
              </label>
              <Textarea
                placeholder="Example: A Telegram notification service that alerts me when an AI provider goes down, with per-key routing and daily usage summaries..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={generating}
                style={{
                  minHeight: "120px",
                  fontSize: "13px",
                  lineHeight: 1.6,
                }}
              />
              <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
                One or two paragraphs is enough. Missing details will be flagged as open architectural questions in Section 8.
              </span>
            </div>

            {/* Quick Inspiration Chips */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)", marginRight: "4px" }}>
                Quick examples:
              </span>
              {EXAMPLE_PROMPTS.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => !generating && setPrompt(ex.text)}
                  style={{
                    fontSize: "11.5px",
                    padding: "4px 8px",
                    borderRadius: "6px",
                    background: "var(--surface-muted)",
                    border: "1px solid var(--inner-border)",
                    color: "var(--text-secondary)",
                    cursor: generating ? "not-allowed" : "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
                >
                  <Sparkles size={11} style={{ display: "inline", marginRight: "4px", verticalAlign: "middle" }} />
                  {ex.label}
                </button>
              ))}
            </div>

            {/* Actions Bar */}
            <Inline gap="10px" style={{ alignItems: "center", justifyContent: "space-between", marginTop: "4px" }}>
              <Inline gap="8px">
                {generating ? (
                  <Button variant="danger" size="sm" onClick={handleStop}>
                    <Square size={14} /> Stop generation
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={!prompt.trim() || !model.trim()}
                  >
                    <Play size={14} /> Generate PRD
                  </Button>
                )}
                {wasTruncated ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleContinue}
                    disabled={generating}
                  >
                    <Play size={14} /> Continue Generating
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleClear}
                  disabled={generating || (!prompt && !document)}
                >
                  <Trash2 size={14} /> Clear
                </Button>
              </Inline>

              {document.trim().length > 0 ? (
                <Inline gap="8px">
                  <div
                    style={{
                      display: "inline-flex",
                      borderRadius: "6px",
                      border: "1px solid var(--inner-border)",
                      background: "var(--surface-muted)",
                      padding: "2px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setViewMode("preview")}
                      style={{
                        padding: "3px 8px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        borderRadius: "4px",
                        border: "none",
                        background: viewMode === "preview" ? "var(--surface-primary)" : "transparent",
                        color: viewMode === "preview" ? "var(--text-primary)" : "var(--text-tertiary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <Eye size={12} /> Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("edit")}
                      style={{
                        padding: "3px 8px",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        borderRadius: "4px",
                        border: "none",
                        background: viewMode === "edit" ? "var(--surface-primary)" : "transparent",
                        color: viewMode === "edit" ? "var(--text-primary)" : "var(--text-tertiary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <Edit3 size={12} /> Edit Markdown
                    </button>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleCopy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleDownload}>
                    <Download size={14} /> Export .md
                  </Button>
                </Inline>
              ) : null}
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {/* Output Document Card */}
      {document.trim().length > 0 || generating ? (
        <Card>
          <CardHeader
            title="Generated Specification"
            subtitle={`${document.split(/\s+/).filter(Boolean).length} words · ${document.length} characters${wasTruncated ? " · ⚠️ Token limit reached (click 'Continue Generating' to resume)" : ""}`}
            icon={<FileText size={16} />}
          />
          <CardBody>
            {viewMode === "preview" ? (
              <div
                style={{
                  minHeight: "300px",
                  lineHeight: 1.7,
                  color: "var(--text-primary)",
                  fontSize: "13.5px",
                }}
              >
                <Markdown text={document || "Generating document…"} />
              </div>
            ) : (
              <Textarea
                value={document}
                onChange={(e) => setDocument(e.target.value)}
                disabled={generating}
                style={{
                  minHeight: "450px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12.5px",
                  lineHeight: 1.6,
                }}
              />
            )}
          </CardBody>
        </Card>
      ) : null}

      {/* Model Picker Modal */}
      <ModelPickerModal
        open={showPicker}
        onClose={() => setShowPicker(false)}
        selected={model ? [model] : []}
        multi={false}
        onToggle={() => {}}
        onSelectOne={(picked) => {
          setModel(picked);
          setShowPicker(false);
        }}
        title="Select Model for PRD Generation"
      />
    </div>
  );
}
