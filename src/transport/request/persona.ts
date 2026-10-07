/**
 * Custom Persona injection.
 *
 * When a tenant has an active persona, the router — not the caller — decides
 * the model's instructions: the persona text REPLACES the request's system
 * content instead of being appended to it. That is the point of the feature
 * (a client's own system prompt, e.g. a coding agent's, must not leak through
 * and compete with the persona), so this is a deliberate overwrite.
 *
 * The transform operates on the *canonical* request, so it covers every wire
 * (chat, responses, messages) and every provider without per-wire surgery. It
 * runs on `system` AND `instructions`: some surfaces (the Responses API)
 * normalize their system text into `instructions`, and leaving that in place
 * would defeat the replacement.
 */
import type { CanonicalRequest, ContentPart } from "../canonical-model";

/**
 * Replaces the request's system content with the persona text.
 *
 * Returns the same request object when there is nothing to do (no persona), so
 * callers can compare by identity. The client's original system/instructions
 * are dropped entirely — an empty persona is treated as "no persona" by the
 * caller and never reaches here.
 */
export function applyPersona(request: CanonicalRequest, personaText: string): CanonicalRequest {
  const text = personaText.trim();
  if (text.length === 0) return request;

  const parts: readonly ContentPart[] = [{ kind: "text", text }];
  // Already exactly the persona (idempotent across retries/re-projections)?
  const current = request.system ?? [];
  const alreadyOnlyPersona =
    current.length === 1 &&
    current[0]?.kind === "text" &&
    current[0].text === text &&
    (request.instructions ?? []).length === 0;
  if (alreadyOnlyPersona) return request;

  return {
    ...request,
    system: parts,
    // The Responses surface carries its system text here; dropping it is part
    // of "replace", not an oversight.
    instructions: [],
    // Marks this text as the router's own instruction. Adapters that must keep
    // a fixed leading system turn for their channel (the buddy family) use this
    // to carry the persona instead of discarding it as caller context.
    persona_injected: true,
  };
}
