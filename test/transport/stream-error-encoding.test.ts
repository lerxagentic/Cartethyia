import { describe, expect, test } from "bun:test";
import { ChatStreamEncoder } from "../../src/transport/surface/chat/encode";
import { CompletionStreamEncoder } from "../../src/transport/surface/completion";
import { createDispatchStreamEncoder } from "../../src/transport/dispatch/stream-bridge";

describe("ChatStreamEncoder.encodeError", () => {
  test("emits error payload and error chunk with finish_reason 'error'", () => {
    const encoder = new ChatStreamEncoder({ model: "test-model" });
    const frames = encoder.encodeError({
      origin: "upstream",
      code: "transport_unavailable",
      message: "upstream stream ended prematurely",
      details: { reason: "timeout" },
    });

    expect(frames).toHaveLength(2);
    const payload = frames[0]!;
    const chunk = frames[1]!;

    // Payload verification
    expect(payload.error_type).toBe("transport_unavailable");
    expect(payload.error_message).toBe("upstream stream ended prematurely");
    expect((payload.error as any).code).toBe("transport_unavailable");
    expect((payload.error as any).origin).toBe("upstream");

    // Chunk verification for OpenAI clients (Hermes, SDK)
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe("test-model");
    expect(chunk.error_type).toBe("transport_unavailable");
    expect(chunk.error_message).toBe("upstream stream ended prematurely");
    expect(Array.isArray(chunk.choices)).toBe(true);
    const choices = chunk.choices as any[];
    expect(choices).toHaveLength(1);
    expect(choices[0].finish_reason).toBe("error");
  });
});

describe("CompletionStreamEncoder.encodeError", () => {
  test("emits error payload and completion chunk with finish_reason 'error'", () => {
    const encoder = new CompletionStreamEncoder({ model: "test-completion" });
    const frames = encoder.encodeError({
      origin: "network",
      code: "deadline_exceeded",
      message: "request deadline exceeded",
      details: {},
    });

    expect(frames).toHaveLength(2);
    const payload = frames[0]!;
    const chunk = frames[1]!;

    expect(payload.error_type).toBe("deadline_exceeded");
    expect((chunk as any).object).toBe("text_completion");
    expect((chunk as any).choices[0].finish_reason).toBe("error");
  });
});

describe("createDispatchStreamEncoder with encodeError", () => {
  test("chat surface formats SSE lines with [DONE] sentinel", () => {
    const streamEncoder = createDispatchStreamEncoder("chat", { model: "gpt-4o" });
    const sseBytes = streamEncoder.encodeError({
      origin: "upstream",
      code: "transport_unavailable",
      message: "upstream failed",
      details: {},
    });

    expect(sseBytes.length).toBeGreaterThanOrEqual(3);
    const decoder = new TextDecoder();
    const text = sseBytes.map((b) => decoder.decode(b)).join("");

    expect(text).toContain("data: {\"error\":");
    expect(text).toContain("\"finish_reason\":\"error\"");
    expect(text).toContain("data: [DONE]\n\n");
  });
});
