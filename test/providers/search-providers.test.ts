/**
 * Bundled web-search request mapping.
 *
 * Each spec is a pure `buildRequest` + `normalize` pair, so the wire shape can be
 * asserted without a network. The properties that matter are the ones a provider
 * silently rejects or degrades on:
 *
 * - **Exa content retrieval.** Exa ignores a top-level `text: true` and returns
 *   only a title and URL unless the request carries `contents`. That shipped as
 *   empty snippets, so the request body is pinned here.
 * - **Credential placement.** Each provider wants its token in a different
 *   header (`x-api-key`, `authorization: Bearer`, `x-subscription-token`); a
 *   wrong one is a 401 the operator would read as a bad key.
 * - **Normalization drops a result with no URL** rather than emitting a row with
 *   an empty link the model cannot cite.
 */
import { describe, expect, test } from "bun:test";
import { SEARCH_PROVIDER_SPECS } from "../../src/providers/search/search-providers";

const params = {
  query: "bun javascript runtime",
  maxResults: 3,
  searchType: "web" as const,
};

describe("search provider request mapping", () => {
  test("exa asks for content inside `contents`, not a top-level `text`", () => {
    const { url, init } = SEARCH_PROVIDER_SPECS.exa.buildRequest(params, "EXA_KEY");
    expect(url).toContain("api.exa.ai");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["contents"]).toEqual({ text: { maxCharacters: 300 }, highlights: true });
    // The ignored top-level flags must be gone, or the request looks correct
    // while returning bare results.
    expect(body["text"]).toBeUndefined();
    expect(body["highlights"]).toBeUndefined();
    expect(body["numResults"]).toBe(3);
  });

  test("exa puts the token in x-api-key", () => {
    const { init } = SEARCH_PROVIDER_SPECS.exa.buildRequest(params, "EXA_KEY");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("EXA_KEY");
  });

  test("tavily uses a bearer token", () => {
    const { url, init } = SEARCH_PROVIDER_SPECS.tavily.buildRequest(params, "TVLY_KEY");
    expect(url).toContain("api.tavily.com");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer TVLY_KEY");
    expect(JSON.parse(String(init.body))["max_results"]).toBe(3);
  });

  test("brave uses x-subscription-token and a GET with a query string", () => {
    const { url, init } = SEARCH_PROVIDER_SPECS.brave.buildRequest(params, "BRAVE_KEY");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-subscription-token"]).toBe("BRAVE_KEY");
    expect(url).toContain("q=bun+javascript+runtime");
    expect(url).toContain("count=3");
  });

  test("a news search switches the endpoint or category", () => {
    const news = { ...params, searchType: "news" as const };
    expect(JSON.parse(String(SEARCH_PROVIDER_SPECS.exa.buildRequest(news, "k").init.body))["category"]).toBe("news");
    expect(JSON.parse(String(SEARCH_PROVIDER_SPECS.tavily.buildRequest(news, "k").init.body))["topic"]).toBe("news");
    expect(SEARCH_PROVIDER_SPECS.brave.buildRequest(news, "k").url).toContain("/news/search");
  });

  test("domain filters split into includes and excludes", () => {
    const filtered = { ...params, domainFilter: ["example.com", "-spam.com"] };
    const exaBody = JSON.parse(String(SEARCH_PROVIDER_SPECS.exa.buildRequest(filtered, "k").init.body));
    expect(exaBody.includeDomains).toEqual(["example.com"]);
    expect(exaBody.excludeDomains).toEqual(["spam.com"]);
    const tavilyBody = JSON.parse(String(SEARCH_PROVIDER_SPECS.tavily.buildRequest(filtered, "k").init.body));
    expect(tavilyBody.include_domains).toEqual(["example.com"]);
    expect(tavilyBody.exclude_domains).toEqual(["spam.com"]);
  });
});

describe("search provider response normalization", () => {
  test("exa reads text and highlights into a snippet", () => {
    const results = SEARCH_PROVIDER_SPECS.exa.normalize({
      results: [
        { title: "A", url: "https://a.test", text: "full text here", highlights: ["a highlight"] },
        { title: "B", url: "https://b.test", text: "x".repeat(500) },
      ],
    });
    expect(results.length).toBe(2);
    expect(results[0]?.snippet).toBe("a highlight");
    // No highlight → the text is used, capped so one result cannot dominate.
    expect(results[1]?.snippet.length).toBeLessThanOrEqual(300);
  });

  test("tavily reads content and score", () => {
    const results = SEARCH_PROVIDER_SPECS.tavily.normalize({
      results: [{ title: "T", url: "https://t.test", content: "body", score: 0.87 }],
    });
    expect(results[0]?.snippet).toBe("body");
    expect(results[0]?.score).toBeCloseTo(0.87);
  });

  test("brave reads web results and description", () => {
    const results = SEARCH_PROVIDER_SPECS.brave.normalize({
      web: { results: [{ title: "W", url: "https://w.test", description: "desc" }] },
    });
    expect(results[0]?.snippet).toBe("desc");
  });

  test("a result without a url is dropped, not emitted empty", () => {
    for (const spec of Object.values(SEARCH_PROVIDER_SPECS)) {
      const results = spec.normalize({
        results: [{ title: "no url" }],
        web: { results: [{ title: "no url" }] },
      });
      expect(results).toEqual([]);
    }
  });

  test("a malformed body yields no results rather than throwing", () => {
    for (const spec of Object.values(SEARCH_PROVIDER_SPECS)) {
      expect(spec.normalize(null)).toEqual([]);
      expect(spec.normalize("nonsense")).toEqual([]);
      expect(spec.normalize({})).toEqual([]);
    }
  });
});
