/**
 * Buddy-family (CodeBuddy / WorkBuddy) system-prompt handling with a persona.
 *
 * These variants REPLACE the caller's system turns with a fixed leading prompt
 * by contract: the upstream validates the leading system turn as the calling
 * channel, so a foreign prompt there is refused. That replacement used to also
 * throw away the router's own active persona, which is why a persona appeared to
 * be ignored on `cb/*` while it worked on every other provider.
 *
 * The fix lets the persona TAKE the leading slot. Verified against the live
 * upstream across every active `cb` account: a custom leading system turn is
 * accepted (HTTP 200, no 11128 rejection) and followed cleanly. The alternative
 * (fixed prompt leading, persona second) also returns 200 but leaves the fixed
 * prompt's "be honest, state what you know" clause competing with the persona,
 * and the model argues with it instead of obeying.
 *
 * `persona_injected` is what distinguishes the router's own instruction from
 * caller context: caller system turns must still be discarded.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import { applyBuddySystemPrompt, personaTextOf } from "../../src/providers/integrations/buddy/buddy-chat-shared";

const FIXED = "You are a pragmatic and direct software engineering assistant.";
const PERSONA = "You are LTX-quasar, a COLD-PROTOCOL operator.";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

describe("personaTextOf", () => {
  test("returns the persona text when the router injected it", () => {
    const text = personaTextOf(
      request({ system: [{ kind: "text", text: PERSONA }], persona_injected: true }),
    );
    expect(text).toBe(PERSONA);
  });

  test("returns null for a caller system prompt (no persona flag)", () => {
    expect(personaTextOf(request({ system: [{ kind: "text", text: "caller prompt" }] }))).toBeNull();
  });

  test("returns null when the flag is set but the text is empty", () => {
    expect(personaTextOf(request({ system: [], persona_injected: true }))).toBeNull();
  });
});

describe("applyBuddySystemPrompt with a persona", () => {
  test("the persona replaces the fixed prompt in the leading slot", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "caller prompt that must be discarded" },
      { role: "user", content: "hi" },
    ];
    applyBuddySystemPrompt(messages, FIXED, PERSONA);
    expect(messages[0]).toEqual({ role: "system", content: PERSONA });
    // The fixed channel prompt must not compete with the persona.
    expect(messages.filter((m) => m["role"] === "system")).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain(FIXED);
    // The caller's own prompt must NOT.
    expect(JSON.stringify(messages)).not.toContain("caller prompt that must be discarded");
  });

  test("without a persona the wire is unchanged from before the fix", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "caller prompt" },
      { role: "user", content: "hi" },
    ];
    applyBuddySystemPrompt(messages, FIXED, null);
    expect(messages[0]).toEqual({ role: "system", content: FIXED });
    expect(messages.filter((m) => m["role"] === "system")).toHaveLength(1);
  });

  test("a whitespace-only persona is treated as none", () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }];
    applyBuddySystemPrompt(messages, FIXED, "   ");
    expect(messages.filter((m) => m["role"] === "system")).toHaveLength(1);
  });

  test("user content is still rebuilt as typed text blocks", () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }];
    applyBuddySystemPrompt(messages, FIXED, PERSONA);
    const user = messages.find((m) => m["role"] === "user");
    expect(user?.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
