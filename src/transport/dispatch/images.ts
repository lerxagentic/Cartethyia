/**
 * OpenAI-compatible Image Generation route (`POST /v1/images/generations`).
 *
 * Dispatches image generation requests to active image-capable providers:
 * - Antigravity (Google Imagen & Gemini Image models via daily-cloudcode-pa)
 * - Dahl (OpenAI-compatible image generation via inference.dahl.global)
 * - OpenAI / Generic BYOK providers
 */
import { eq, and } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts } from "../../persistence/schema";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../gateway-error";
import type { ProxyRequestStateStore } from "../request/state";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";

export interface ImagesHandlerDeps {
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

interface ImageGenerationBody {
  prompt?: string;
  model?: string;
  n?: number;
  size?: string;
  response_format?: "b64_json" | "url";
  quality?: string;
  style?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function sizeToAspectRatio(size: string): string {
  switch (size) {
    case "1024x1792":
    case "768x1344":
      return "9:16";
    case "1792x1024":
    case "1344x768":
      return "16:9";
    case "1280x960":
      return "4:3";
    case "960x1280":
      return "3:4";
    default:
      return "1:1";
  }
}

function sizeToDimensions(size: string): { width: number; height: number } {
  switch (size) {
    case "1792x1024":
    case "16:9":
      return { width: 1280, height: 720 };
    case "1024x1792":
    case "9:16":
      return { width: 720, height: 1280 };
    case "1280x960":
    case "4:3":
      return { width: 1024, height: 768 };
    case "960x1280":
    case "3:4":
      return { width: 768, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
}

async function handlePollinationsImage(
  prompt: string,
  size: string,
  model = "flux",
): Promise<Response> {
  const { width, height } = sizeToDimensions(size);
  const cleanModel = model.replace(/^pollinations\//, "").replace(/^flux\//, "") || "flux";
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${encodeURIComponent(cleanModel)}&nologo=true`;

  const upstreamRes = await fetch(url);
  if (!upstreamRes.ok) {
    throw new GatewayError("platform_unavailable", 502, `Image generation failed (${upstreamRes.status})`);
  }

  const buf = await upstreamRes.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");

  return jsonResponse({
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json: b64,
        revised_prompt: prompt,
      },
    ],
  });
}

export function createImagesHandler(deps: ImagesHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = (state.ingressBody ?? {}) as ImageGenerationBody;

    if (!authorization) {
      throw new GatewayError("authentication_failed", 401, "API key required");
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      throw new GatewayError("invalid_request", 400, "Missing required field: prompt");
    }

    const requestedModel = (typeof body.model === "string" ? body.model.trim() : "") || "pollinations/flux";
    const requestedSize = typeof body.size === "string" ? body.size : "1024x1024";

    // 1. Pollinations / Flux Image Generation
    const isPollinations =
      requestedModel.startsWith("pollinations/") ||
      requestedModel.startsWith("flux/") ||
      /flux|pollinations|turbo/i.test(requestedModel);

    if (isPollinations) {
      return await handlePollinationsImage(prompt, requestedSize, requestedModel);
    }

    // 2. Antigravity Image Generation
    const isAntigravity =
      requestedModel.startsWith("antigravity/") ||
      /gemini.*image|imagen/i.test(requestedModel);

    if (isAntigravity) {
      return await handleAntigravityImage(deps, requestedModel, prompt, requestedSize);
    }

    // 3. Dahl / OpenAI Compatible Image Generation
    const isDahl =
      requestedModel.startsWith("dahl/") ||
      requestedModel.startsWith("openai/") ||
      /dall-e|gpt-image/i.test(requestedModel);

    if (isDahl) {
      return await handleDahlImage(deps, requestedModel, prompt, requestedSize, body);
    }

    // Default fallback to Pollinations / Flux
    return await handlePollinationsImage(prompt, requestedSize, "flux");
  };
}

async function handleAntigravityImage(
  deps: ImagesHandlerDeps,
  modelStr: string,
  prompt: string,
  size: string,
): Promise<Response> {
  const db = deps.db;
  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.providerId, "antigravity"), eq(providerAccounts.status, "active")));

  if (accounts.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "No active Antigravity account available for image generation");
  }

  const cleanModel = modelStr.replace(/^antigravity\//, "");
  const aspectRatio = sizeToAspectRatio(size);

  for (const account of accounts) {
    if (!account.credentialCiphertext) continue;
    let token = "";
    try {
      token = decryptCredentialToString(account.credentialCiphertext);
    } catch {
      continue;
    }
    if (!token) continue;

    const projectId =
      ((account.authState as Record<string, unknown> | null)?.projectId as string) ||
      "aicode-consumers";

    const agBody = {
      project: projectId,
      model: cleanModel.includes("imagen") ? cleanModel : "gemini-3.1-flash-image",
      userAgent: "antigravity",
      requestType: "image_gen",
      requestId: `agent/image/${Date.now()}/${Math.random().toString(36).slice(2, 8)}/1`,
      request: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
          imageConfig: {
            aspectRatio,
          },
        },
        sessionId: `-${Math.floor(Math.random() * 8999999999999999 + 1000000000000000)}`,
      },
    };

    try {
      const upstreamRes = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "antigravity/1.0.0",
        },
        body: JSON.stringify(agBody),
      });

      if (!upstreamRes.ok) {
        continue;
      }

      const resJson = (await upstreamRes.json()) as Record<string, any>;
      const resp = resJson.response || resJson;
      const candidates = resp.candidates || [];
      const parts = candidates[0]?.content?.parts || [];

      const images: Array<{ b64_json?: string; revised_prompt?: string }> = [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          images.push({
            b64_json: part.inlineData.data,
            revised_prompt: prompt,
          });
        }
      }

      if (images.length > 0) {
        return jsonResponse({
          created: Math.floor(Date.now() / 1000),
          data: images,
        });
      }
    } catch {
      // try next account
    }
  }

  // If all Antigravity accounts are exhausted/blocked, failover gracefully to Pollinations / Flux
  return await handlePollinationsImage(prompt, size, "flux");
}

async function handleDahlImage(
  deps: ImagesHandlerDeps,
  modelStr: string,
  prompt: string,
  size: string,
  body: ImageGenerationBody,
): Promise<Response> {
  const db = deps.db;
  const accounts = await db
    .select()
    .from(providerAccounts)
    .where(and(eq(providerAccounts.providerId, "dahl"), eq(providerAccounts.status, "active")));

  if (accounts.length === 0) {
    throw new GatewayError("admission_unavailable", 503, "No active Dahl account available for image generation");
  }

  let apiKey = "";
  for (const acc of accounts) {
    if (acc.credentialCiphertext) {
      try {
        apiKey = decryptCredentialToString(acc.credentialCiphertext);
        break;
      } catch {}
    }
  }

  if (!apiKey) {
    throw new GatewayError("authentication_failed", 500, "Failed to decrypt Dahl credential");
  }

  const cleanModel = modelStr.replace(/^dahl\//, "").replace(/^openai\//, "");
  const payload = {
    model: cleanModel,
    prompt,
    n: body.n ?? 1,
    size: size || "1024x1024",
    response_format: body.response_format || "b64_json",
  };

  const upstreamRes = await fetch("https://inference.dahl.global/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => "");
    throw new GatewayError("platform_unavailable", 502, `Dahl image generation failed (${upstreamRes.status}): ${errText}`);
  }

  const resJson = await upstreamRes.json();
  return jsonResponse(resJson);
}
