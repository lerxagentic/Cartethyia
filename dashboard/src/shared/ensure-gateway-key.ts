import { readStorage, writeSession, STUDIO_KEY_STORAGE, STUDIO_PREFIX_STORAGE } from "./studio-session-storage";
import { consoleRequest } from "../data/api";
import type { StudioKeyResult } from "../hooks/studio";

/**
 * Returns a valid gateway API key for direct `/v1/*` data-plane calls
 * made from console tools (Studio, Arena, PRD Builder).
 * Caches in sessionStorage across route transitions.
 */
export async function ensureGatewayKey(): Promise<string> {
  const cached = readStorage(STUDIO_KEY_STORAGE);
  if (cached && cached.trim().length > 0) return cached;
  const res = await consoleRequest<StudioKeyResult>("/studio/key", {
    method: "POST",
    body: "{}",
  });
  if (!res.key) throw new Error("No gateway key available");
  writeSession(STUDIO_KEY_STORAGE, res.key);
  if (res.prefix) writeSession(STUDIO_PREFIX_STORAGE, res.prefix);
  return res.key;
}
