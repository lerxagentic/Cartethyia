/**
 * Stop-reason mapping when a provider emits a tool call.
 *
 * Gemini and Antigravity both report `finishReason: "STOP"` on the same turn
 * they return `functionCall` parts — the stream ended normally *because* the
 * model handed back a call to run. A mapping that resolves `STOP -> "stop"`
 * before looking at the tool calls therefore tells the client the turn is a
 * finished answer, the tool loop never executes, and the Model Lab renders
 * "(no visible output)" while the model actually asked for `web_search`.
 *
 * The rule pinned here: a pending tool call outranks the provider's reason,
 * except a hard `MAX_TOKENS`, which genuinely means the answer was cut off.
 */
import { describe, expect, test } from "bun:test";
import { toCanonicalStop } from "../../src/providers/integrations/antigravity/antigravity";

describe("antigravity stop-reason mapping", () => {
  test("a tool call wins over STOP", () => {
    // The regression: STOP + a function call was reported as a finished answer.
    expect(toCanonicalStop("STOP", 1)).toBe("tool_use");
    expect(toCanonicalStop("STOP", 3)).toBe("tool_use");
  });

  test("a tool call wins over an unmapped reason too", () => {
    expect(toCanonicalStop("SOMETHING_NEW", 1)).toBe("tool_use");
  });

  test("MAX_TOKENS is a length stop even with a partial tool call", () => {
    // Truncation means the call's arguments may be incomplete, so the caller
    // must not treat it as a runnable request.
    expect(toCanonicalStop("MAX_TOKENS", 1)).toBe("length");
  });

  test("no tool call falls back to the provider's reason", () => {
    expect(toCanonicalStop("STOP", 0)).toBe("stop");
    expect(toCanonicalStop("SAFETY", 0)).toBe("content_filter");
    expect(toCanonicalStop(undefined, 0)).toBe("stop");
  });

  test("SAFETY with a tool call is still a tool call", () => {
    // The model asked for a tool; a safety note alongside it does not make the
    // turn a plain content filter.
    expect(toCanonicalStop("SAFETY", 2)).toBe("tool_use");
  });
});
