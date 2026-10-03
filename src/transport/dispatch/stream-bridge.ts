import type { CanonicalEvent, SourceSurface } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import { formatSseData, formatSseEvent } from "../surface/stream-frame";
import { ChatStreamEncoder } from "../surface/chat/encode";
import { ResponsesEventEncoder } from "../surface/responses/encode";
import { MessagesStreamEncoder } from "../surface/messages/stream";
import { CompletionStreamEncoder } from "../surface/completion";

export interface DispatchStreamEncoder {
  push(event: CanonicalEvent): Uint8Array[];
  finish(): Uint8Array[];
  encodeError(input: {
    readonly origin: string;
    readonly code: string;
    readonly message: string;
    readonly details: unknown;
  }): Uint8Array[];
}

/** Creates the surface encoder used by both streaming transport paths. */
export function createDispatchStreamEncoder(
  surface: SourceSurface,
  options: Record<string, unknown>,
): DispatchStreamEncoder {
  // `chat` and `completion` frame the same way: unnamed `data:` frames with an
  // explicit `[DONE]` sentinel and a bare error object. Only the encoder class
  // differs, so they share one builder rather than two copies that must be
  // edited together.
  if (surface === "chat" || surface === "completion") {
    const encoder =
      surface === "chat"
        ? new ChatStreamEncoder(options as never)
        : new CompletionStreamEncoder(options as never);
    return {
      push: (event) => encoder.push(event).map(formatSseData),
      finish: () => [...encoder.finish().map(formatSseData), formatSseData("[DONE]")],
      encodeError: (input) => [
        ...encoder.encodeError(input).map(formatSseData),
        formatSseData("[DONE]"),
      ],
    };
  }
  if (surface === "responses") {
    const encoder = new ResponsesEventEncoder(options as never);
    return {
      push: (event) => encoder.push(event).map((wire) => formatSseEvent(wire.type, wire)),
      finish: () => encoder.finish().map((wire) => formatSseEvent(wire.type, wire)),
      encodeError: ({ origin, code, message, details }) => [
        formatSseEvent("response.error", { type: "response.error", origin, code, message, details }),
        formatSseEvent("response.done", { type: "response.done", response: { status: "failed" } }),
      ],
    };
  }
  if (surface === "messages") {
    const encoder = new MessagesStreamEncoder(options as never);
    return {
      push: (event) => encoder.push(event).map((wire) => formatSseEvent(String(wire.type), wire)),
      finish: () => encoder.finish().map((wire) => formatSseEvent(String(wire.type), wire)),
      encodeError: ({ origin, code, message, details }) => [
        formatSseEvent("error", { type: "error", origin, error: { type: code, message, details } }),
        formatSseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "error", stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
        formatSseEvent("message_stop", { type: "message_stop" }),
      ],
    };
  }
  throw new GatewayError(
    "capability_unsupported",
    400,
    `Unknown surface: ${surface}`,
    { surface },
  );
}