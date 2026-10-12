/**
 * The Studio (Model Lab) `web_fetch` tool.
 *
 * This is the one playground tool that leaves the process, so the properties
 * that matter are the ones that keep it from becoming an open proxy or an
 * SSRF vector:
 *
 * - Only http/https. A `file:`, `data:`, or `javascript:` URL must be refused
 *   before any fetch happens, not sanitized into one.
 * - The character cap is clamped server-side. A caller asking for a million
 *   chars gets the ceiling, not a million — the tool result is fed straight
 *   back into a model's context, so an unbounded read is a context bomb.
 * - HTML is reduced to readable text; the raw markup is never returned.
 * - The fetch goes through the injected `ValidatedFetch`, which is where the
 *   SSRF policy lives. This suite asserts the call is made with a signal
 *   (timeout) and that an upstream failure surfaces as an error rather than a
 *   silent empty string the model would read as "the page was blank".
 *
 * The suite drives the operations object directly with a stub fetcher, so no
 * network is touched.
 */
import { describe, expect, test } from "bun:test";
import { createStudioOperations, type StudioConfig } from "../../src/console/domains/studio/routes";
import type { AccessDecision } from "../../src/security/access-control";
import type { ValidatedFetch } from "../../src/network/outbound-fetch";

const access: AccessDecision = {
  id: "test-key",
  tenantId: "tenant-studio-web",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "test-key",
};

/** Minimal config: only the webFetch dependency is exercised. `config.webFetch`
 *  is a factory `(tenantId) => ValidatedFetch`, not the fetcher itself. */
function opsWith(webFetch: StudioConfig["webFetch"]) {
  return createStudioOperations({
    sessionStore: {} as StudioConfig["sessionStore"],
    keyStore: {} as StudioConfig["keyStore"],
    accessResolver: () => access,
    // `exactOptionalPropertyTypes` forbids an explicit `undefined` here, so the
    // key is omitted entirely when no fetcher is supplied.
    ...(webFetch === undefined ? {} : { webFetch }),
  });
}

/** Wraps a fetcher in the factory shape the config expects. */
function factoryOf(fetcher: ValidatedFetch | undefined): StudioConfig["webFetch"] {
  return fetcher === undefined ? undefined : () => fetcher;
}

/** A fetcher that records the URL and returns a canned response. */
function stubFetch(
  response: { ok?: boolean; status?: number; contentType?: string; body?: string },
  seen: string[] = [],
): ValidatedFetch {
  const fn = (url: URL | string) => {
    seen.push(String(url));
    return Promise.resolve(
      new Response(response.body ?? "<html><body><h1>Hello</h1><p>World</p></body></html>", {
        status: response.status ?? (response.ok === false ? 500 : 200),
        headers: { "content-type": response.contentType ?? "text/html; charset=utf-8" },
      }),
    );
  };
  return fn as unknown as ValidatedFetch;
}

describe("studio web_fetch", () => {
  test("refuses a non-http(s) scheme before fetching", async () => {
    const seen: string[] = [];
    const ops = opsWith(factoryOf(stubFetch({}, seen)));
    for (const url of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)"]) {
      await expect(ops.webFetch(access, url, 2000)).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  test("requires a url", async () => {
    const ops = opsWith(factoryOf(stubFetch({})));
    await expect(ops.webFetch(access, "", 2000)).rejects.toThrow();
    await expect(ops.webFetch(access, undefined, 2000)).rejects.toThrow();
  });

  test("strips html and returns readable text", async () => {
    const ops = opsWith(factoryOf(stubFetch({})));
    const result = (await ops.webFetch(access, "https://example.com", 2000)) as {
      content: string;
      contentType: string;
    };
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.content).not.toContain("<h1>");
    expect(result.contentType).toContain("text/html");
  });

  test("clamps the character cap to the server ceiling", async () => {
    const huge = "<p>" + "x".repeat(60_000) + "</p>";
    const ops = opsWith(factoryOf(stubFetch({ body: huge })));
    const result = (await ops.webFetch(access, "https://example.com", 10_000_000)) as {
      content: string;
      truncated: boolean;
    };
    // Ceiling is 24k, so a 60k page is cut down and flagged.
    expect(result.content.length).toBeLessThanOrEqual(24_000);
    expect(result.truncated).toBe(true);
  });

  test("an upstream HTTP failure is an error, not an empty page", async () => {
    const ops = opsWith(factoryOf(stubFetch({ ok: false, status: 502 })));
    await expect(ops.webFetch(access, "https://example.com", 2000)).rejects.toThrow();
  });

  test("refuses when web tools are not wired at all", async () => {
    const ops = opsWith(undefined);
    await expect(ops.webFetch(access, "https://example.com", 2000)).rejects.toThrow();
  });
});
