/**
 * The Studio (Model Lab) `http_request` tool.
 *
 * This tool lets a model send an arbitrary method and body to an arbitrary
 * URL, which makes the properties that matter the ones that bound it:
 *
 * - **Method is whitelisted.** A `TRACE` or an unparseable method must be
 *   refused, not forwarded.
 * - **The URL goes through the same http/https check as `web_fetch`**, so a
 *   `file:` or `data:` URL is refused before any fetch — this is the SSRF
 *   boundary, and the request must reach the injected `ValidatedFetch`.
 * - **The model cannot set identity headers.** `authorization`, `cookie`,
 *   `host`, and `content-length` are stripped: the first two would let a
 *   prompt-injected page make authenticated calls with the operator's
 *   credentials, and the last two are re-derived by the HTTP client.
 * - **A GET carries no body** — some servers reject it, and silently sending
 *   one turns a read into a write attempt.
 * - **The response is capped and its status surfaced**, so a model sees
 *   `status: 404` instead of an empty string it reads as success.
 *
 * The suite drives the operations object with a stub fetcher, so no network is
 * touched.
 */
import { describe, expect, test } from "bun:test";
import { createStudioOperations, type StudioConfig } from "../../src/console/domains/studio/routes";
import type { AccessDecision } from "../../src/security/access-control";
import type { ValidatedFetch } from "../../src/network/outbound-fetch";

const access: AccessDecision = {
  id: "test-key",
  tenantId: "tenant-studio-http",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "test-key",
};

function opsWith(webFetch: StudioConfig["webFetch"]) {
  return createStudioOperations({
    sessionStore: {} as StudioConfig["sessionStore"],
    keyStore: {} as StudioConfig["keyStore"],
    accessResolver: () => access,
    ...(webFetch === undefined ? {} : { webFetch }),
  });
}

/** A fetcher that records the URL and init, and returns a canned response. */
function recordingFetch(
  response: { status?: number; contentType?: string; body?: string } = {},
  seen: Array<{ url: string; init: RequestInit | undefined }> = [],
): ValidatedFetch {
  const fn = (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const body = response.body ?? "{\"ok\":true}";
    return Promise.resolve(
      new Response(body, {
        status: response.status ?? 200,
        headers: { "content-type": response.contentType ?? "application/json" },
      }),
    );
  };
  return fn as unknown as ValidatedFetch;
}

const factoryOf = (fetcher: ValidatedFetch): StudioConfig["webFetch"] => () => fetcher;

describe("studio http_request", () => {
  test("sends the method, url, and body through the validated fetcher", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ops = opsWith(factoryOf(recordingFetch({}, seen)));
    const out = (await ops.httpRequest(access, {
      method: "POST",
      url: "https://api.example.com/things",
      headers: { "content-type": "application/json" },
      body: '{"name":"x"}',
    })) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.example.com/things");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.body).toBe('{"name":"x"}');
    expect(out.status).toBe(200);
    expect(out.ok).toBe(true);
  });

  test("refuses a non-http(s) scheme before fetching", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ops = opsWith(factoryOf(recordingFetch({}, seen)));
    for (const url of ["file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)"]) {
      await expect(ops.httpRequest(access, { method: "GET", url })).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  test("refuses a method outside the whitelist", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ops = opsWith(factoryOf(recordingFetch({}, seen)));
    for (const method of ["TRACE", "CONNECT", "OPTIONS", "nonsense", ""]) {
      await expect(ops.httpRequest(access, { method, url: "https://api.example.com" })).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  test("strips identity headers the model must not control", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ops = opsWith(factoryOf(recordingFetch({}, seen)));
    await ops.httpRequest(access, {
      method: "GET",
      url: "https://api.example.com",
      headers: {
        Authorization: "Bearer stolen",
        Cookie: "session=stolen",
        Host: "evil.example",
        "Content-Length": "999",
        "X-Custom": "kept",
      },
    });
    const sent = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(sent["authorization"]).toBeUndefined();
    expect(sent["cookie"]).toBeUndefined();
    expect(sent["host"]).toBeUndefined();
    expect(sent["content-length"]).toBeUndefined();
    expect(sent["x-custom"]).toBe("kept");
  });

  test("a GET carries no body", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ops = opsWith(factoryOf(recordingFetch({}, seen)));
    await ops.httpRequest(access, { method: "GET", url: "https://api.example.com", body: '{"a":1}' });
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  test("surfaces the upstream status rather than an empty string", async () => {
    const ops = opsWith(factoryOf(recordingFetch({ status: 404, body: "{\"error\":\"gone\"}" })));
    const out = (await ops.httpRequest(access, { method: "GET", url: "https://api.example.com" })) as Record<
      string,
      unknown
    >;
    expect(out.status).toBe(404);
    expect(out.ok).toBe(false);
  });

  test("fails closed when web tools are not wired", async () => {
    const ops = opsWith(undefined);
    await expect(ops.httpRequest(access, { method: "GET", url: "https://api.example.com" })).rejects.toThrow();
  });

  test("requires a url", async () => {
    const ops = opsWith(factoryOf(recordingFetch({})));
    await expect(ops.httpRequest(access, { method: "GET" })).rejects.toThrow();
  });
});
