/**
 * Tool-call id de-duplication for replayed histories.
 *
 * A client that replays its conversation verbatim can reuse one `call_...` id
 * across turns. Gemini encodes every occurrence as a `functionCall` part, so a
 * repeated id reaches the upstream as a duplicate and is rejected with a
 * detail-free HTTP 400 INVALID_ARGUMENT. These cases pin the repair: later
 * occurrences are renamed, every result follows the occurrence it answered, and
 * an already-unique history is left untouched (same object reference, so the
 * caller's fast path stays fast).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, CanonicalRequest } from "../../src/transport/canonical-model";
import { dedupeRequestToolIds } from "../../src/transport/translation/tool-id";

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function request(messages: CanonicalMessage[]): CanonicalRequest {
  return {
    model: "gemini-3.8-flash",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function callIds(req: CanonicalRequest): string[] {
  return req.messages.flatMap((m) =>
    m.content.filter((p) => p.kind === "toolCall").map((p) => (p as { call_id: string }).call_id),
  );
}

function resultIds(req: CanonicalRequest): string[] {
  return req.messages.flatMap((m) =>
    m.content.filter((p) => p.kind === "toolResult").map((p) => (p as { call_id: string }).call_id),
  );
}

const assistantCall = (id: string, name: string): CanonicalMessage => ({
  role: "assistant",
  content: [{ kind: "toolCall", call_id: id, name, arguments: "{}" }],
});

const toolResult = (id: string, content: string): CanonicalMessage => ({
  role: "tool",
  content: [{ kind: "toolResult", call_id: id, content }],
});

describe("dedupeRequestToolIds", () => {
  test("a reused call id is renamed on its later occurrence only", () => {
    const req = request([
      assistantCall("call_X", "read_file"),
      toolResult("call_X", "first"),
      assistantCall("call_X", "terminal"),
      toolResult("call_X", "second"),
    ]);
    const out = dedupeRequestToolIds(req);
    const calls = callIds(out);
    expect(new Set(calls).size).toBe(calls.length);
    // The first occurrence keeps the client's own id — that is the one the
    // replayed history refers to.
    expect(calls[0]).toBe("call_X");
    expect(calls[1]).not.toBe("call_X");
  });

  test("each result follows the occurrence it answered", () => {
    const req = request([
      assistantCall("call_X", "read_file"),
      toolResult("call_X", "first"),
      assistantCall("call_X", "terminal"),
      toolResult("call_X", "second"),
    ]);
    const out = dedupeRequestToolIds(req);
    // Positional pairing: result N must answer call N, not both results the
    // first call. Matching on the bare id would collapse them.
    expect(resultIds(out)).toEqual(callIds(out));
  });

  test("replacement ids stay valid for strict wires", () => {
    const req = request([
      assistantCall("call_X", "a"),
      toolResult("call_X", "1"),
      assistantCall("call_X", "b"),
      toolResult("call_X", "2"),
      assistantCall("call_X", "c"),
      toolResult("call_X", "3"),
    ]);
    const out = dedupeRequestToolIds(req);
    expect(callIds(out).every((id) => TOOL_ID_PATTERN.test(id))).toBe(true);
    expect(new Set(callIds(out)).size).toBe(3);
  });

  test("the input request is never mutated", () => {
    const req = request([
      assistantCall("call_X", "read_file"),
      toolResult("call_X", "first"),
      assistantCall("call_X", "terminal"),
      toolResult("call_X", "second"),
    ]);
    dedupeRequestToolIds(req);
    expect(callIds(req)).toEqual(["call_X", "call_X"]);
    expect(resultIds(req)).toEqual(["call_X", "call_X"]);
  });

  test("a history with unique ids is returned by reference", () => {
    const req = request([assistantCall("call_a", "x"), toolResult("call_a", "r")]);
    // Same object: the caller's no-op fast path must not pay for a clone.
    expect(dedupeRequestToolIds(req)).toBe(req);
  });

  test("ids that collide with a generated name are still made unique", () => {
    // A hostile/lucky client id equal to the generated stem must not be
    // silently reused — uniqueness is the invariant, not the exact spelling.
    const req = request([
      assistantCall("call_X", "a"),
      toolResult("call_X", "1"),
      assistantCall("call_X", "b"),
      toolResult("call_X", "2"),
    ]);
    const out = dedupeRequestToolIds(req);
    const calls = callIds(out);
    expect(new Set(calls).size).toBe(2);
    expect(resultIds(out)).toEqual(calls);
  });
});
