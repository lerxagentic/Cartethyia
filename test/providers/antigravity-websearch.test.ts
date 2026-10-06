/**
 * Antigravity wire shape for web search.
 *
 * Cloud Code Assist rejects a request that mixes the built-in `googleSearch`
 * tool with `functionDeclarations` — with a message that misdirects the reader
 * ("Please enable tool_config.include_server_side_tool_invocations…", a control
 * of the public Gemini API that this endpoint ignores). Two separate mistakes
 * used to create that mix:
 *
 * 1. The built-in was injected whenever a tool was merely *named* `web_search`,
 *    even when the caller declared it as a plain function it runs itself.
 *    OpenAI-compatible agents (Hermes among them) always do. The discriminator
 *    must be the canonical `tool_type`, never the name.
 * 2. The built-in was pushed as its own `tools[]` entry. Google's wire carries
 *    the built-in and the declarations in ONE `Tool` object, so there was no
 *    valid pair for the flag to authorize even when it was set.
 *
 * These cases capture the outbound body and assert the shape that is accepted:
 * a function tool named `web_search` stays a function; a genuine hosted search
 * is merged into the declarations group and authorizes the combination.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import { createAntigravityAdapter } from "../../src/providers/integrations/antigravity/antigravity";

interface Captured {
  request?: Record<string, unknown>;
}

/** Dispatch once with a mock fetch and return the JSON body sent upstream. */
async function captureBody(request: CanonicalRequest): Promise<Captured> {
  let captured: Captured = {};
  const mockFetch = async (_url: string, init: { body?: unknown }) => {
    if (typeof init?.body === "string") {
      try {
        captured = JSON.parse(init.body) as Captured;
      } catch {
        captured = {};
      }
    }
    return new Response(
      JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const adapter = createAntigravityAdapter({ fetch: mockFetch as unknown as typeof fetch, baseUrl: "https://example.invalid" });
  const context = {
    credential: { credential_kind: "oauth", secret: new TextEncoder().encode("tok"), account_id: "acct" },
    abort_signal: new AbortController().signal,
    outbound_fetch: mockFetch,
  };
  for await (const _event of adapter.dispatch(
    request,
    { model_id: "gemini-3.8-flash", wire_family: "chat" } as never,
    context as never,
  )) {
    // Drain: the payload is captured by the mock before any event arrives.
  }
  return captured;
}

function requestWith(tools: CanonicalRequest["tools"]): CanonicalRequest {
  return {
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    ...(tools === undefined ? {} : { tools }),
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

const functionTool = (name: string) => ({
  name,
  description: "d",
  jsonSchema: { type: "object", properties: {} },
});

describe("antigravity web search wire shape", () => {
  test("a function tool merely NAMED web_search is not rewritten into googleSearch", async () => {
    const body = await captureBody(requestWith([functionTool("web_search")]));
    const tools = body.request?.tools as Record<string, unknown>[] | undefined;
    expect(tools?.some((group) => "googleSearch" in group), "built-in injected for a plain function tool").toBe(false);
    // The client's function declaration must survive intact.
    expect(JSON.stringify(tools)).toContain("web_search");
  });

  test("a hosted search alongside functions merges into one group and authorizes the mix", async () => {
    const body = await captureBody(
      requestWith([
        { ...functionTool("web_search_preview"), tool_type: "web_search" } as never,
        functionTool("read_file"),
      ]),
    );
    const tools = body.request?.tools as Record<string, unknown>[];
    const group = tools.find((entry) => Array.isArray(entry.functionDeclarations));
    expect(group, "no function group").toBeDefined();
    // Built-in and declarations must ride the SAME Tool object.
    expect(group?.googleSearch, "googleSearch not merged into the declaration group").toEqual({});
    expect(tools.filter((entry) => "googleSearch" in entry)).toHaveLength(1);
    expect(body.request?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  });

  test("a hosted search alone adds the built-in without the combination flag", async () => {
    const body = await captureBody(
      requestWith([{ ...functionTool("web_search_preview"), tool_type: "web_search" } as never]),
    );
    const tools = body.request?.tools as Record<string, unknown>[];
    expect(tools.some((entry) => "googleSearch" in entry)).toBe(true);
    // No declarations beside it means no combination to authorize.
    expect(body.request?.toolConfig).toBeUndefined();
  });

  test("a request with no hosted search never gains a built-in", async () => {
    const body = await captureBody(requestWith([functionTool("read_file")]));
    const tools = body.request?.tools as Record<string, unknown>[];
    expect(tools.some((entry) => "googleSearch" in entry)).toBe(false);
  });
});
