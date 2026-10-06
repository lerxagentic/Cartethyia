/**
 * Custom Persona injection.
 *
 * The feature's whole point is that the ROUTER decides the model's
 * instructions: an active persona must REPLACE the client's system content,
 * not sit beside it. A coding agent (Hermes, Claude Code, …) always sends its
 * own system prompt, so "append" would let that prompt compete with — and
 * usually outrank — the persona. These cases pin the replacement, on both
 * canonical homes for system text (`system` and the Responses `instructions`).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import { applyPersona } from "../../src/transport/request/persona";

function base(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "gemini-3.8-flash",
    system: [{ kind: "text", text: "client system prompt" }],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

describe("applyPersona", () => {
  test("replaces the client's system content instead of appending to it", () => {
    const next = applyPersona(base(), "You are a pirate.");
    expect(next.system).toEqual([{ kind: "text", text: "You are a pirate." }]);
    // The client's own prompt must be gone, not merely outnumbered.
    expect(JSON.stringify(next.system)).not.toContain("client system prompt");
  });

  test("also clears the Responses-surface `instructions`, which is the other home for system text", () => {
    const next = applyPersona(
      base({ instructions: [{ kind: "text", text: "responses instructions" }] }),
      "You are a pirate.",
    );
    expect(next.instructions).toEqual([]);
    expect(next.system).toEqual([{ kind: "text", text: "You are a pirate." }]);
  });

  test("a request with no system content gains the persona", () => {
    const next = applyPersona(base({ system: [] }), "You are a pirate.");
    expect(next.system).toEqual([{ kind: "text", text: "You are a pirate." }]);
  });

  test("replaces several existing system parts with the single persona part", () => {
    const next = applyPersona(
      base({
        system: [
          { kind: "text", text: "part one" },
          { kind: "text", text: "part two" },
        ],
      }),
      "You are a pirate.",
    );
    expect(next.system).toHaveLength(1);
  });

  test("messages are never touched — only the system prompt is replaced", () => {
    const request = base();
    const next = applyPersona(request, "You are a pirate.");
    expect(next.messages).toBe(request.messages);
  });

  test("an empty/whitespace persona is a no-op (treated as 'no persona')", () => {
    const request = base();
    expect(applyPersona(request, "")).toBe(request);
    expect(applyPersona(request, "   \n  ")).toBe(request);
  });

  test("is idempotent: re-applying the same persona returns the same object", () => {
    const once = applyPersona(base(), "You are a pirate.");
    expect(applyPersona(once, "You are a pirate.")).toBe(once);
  });

  test("the persona text is trimmed before use", () => {
    const next = applyPersona(base(), "  You are a pirate.  ");
    expect(next.system).toEqual([{ kind: "text", text: "You are a pirate." }]);
  });
});
