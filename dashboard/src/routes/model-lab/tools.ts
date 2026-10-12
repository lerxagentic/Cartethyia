import { isRecord, readConsoleCsrfCookie } from "../../data/api";
import { runInSandbox } from "./sandbox";

/** Client-executed playground tools: local utilities plus safe web helpers. */
export const STUDIO_TOOLS = [
  {
    name: "printf",
    description: "Print text back verbatim. Useful for testing live tool calling.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to print" } },
      required: ["text"],
    },
  },
  {
    name: "clock",
    description: "Get the current local date and time.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "web_fetch",
    description: "Fetch and extract readable text from a public HTTP(S) page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "An absolute HTTP or HTTPS URL" },
        maxChars: { type: "integer", minimum: 1000, maximum: 24000 },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web and return ranked results (title, url, snippet). Use it when the answer depends on current information you do not already know.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: { type: "integer", minimum: 1, maximum: 10, description: "How many results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "calculate",
    description:
      "Evaluate an arithmetic expression exactly. Supports + - * / % ** and parentheses. Use this instead of doing mental arithmetic.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "e.g. (1200 * 1.08) ** 2 / 3" },
      },
      required: ["expression"],
    },
  },
  {
    name: "run_javascript",
    description:
      "Run JavaScript in a sandboxed worker and return what the last expression evaluates to. Use it for data transformation, string/array processing, date math, or any computation too involved to do by hand. No network, DOM, or file access; input is available as the `input` variable.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript source. The value of the final expression is returned.",
        },
        input: {
          type: "string",
          description: "Optional string/JSON passed in as the `input` variable.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "json_query",
    description:
      "Read a value out of a JSON document by path. Use dot notation for keys and [n] for array indexes, e.g. `data.items[0].name`.",
    parameters: {
      type: "object",
      properties: {
        json: { type: "string", description: "The JSON document as text" },
        path: { type: "string", description: "Dot/bracket path, e.g. data.items[0].name" },
      },
      required: ["json"],
    },
  },
  {
    name: "base64",
    description: "Encode text to base64 or decode base64 back to text.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["encode", "decode"] },
        text: { type: "string", description: "The text to encode, or base64 to decode" },
      },
      required: ["mode", "text"],
    },
  },
  {
    name: "render_mermaid",
    description: "Convert Mermaid flowchart or sequence syntax to a readable ASCII diagram.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "Mermaid diagram source" } },
      required: ["code"],
    },
  },
] as const;

export const MAX_TOOL_TURNS = 5;

/** Tools that reach the network. They are opt-in per prompt, never armed by
 *  default, so a generic question cannot silently trigger a fetch or a search. */
export const NETWORK_TOOL_NAMES = ["web_fetch", "web_search"] as const;

/** Tools that need a capability the page must provide (a sandboxed worker). */
export const SANDBOX_TOOL_NAMES = ["run_javascript"] as const;

export const TOOL_DEFS = STUDIO_TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

const NETWORK_TOOLS = new Set<string>(NETWORK_TOOL_NAMES);

export const LOCAL_TOOL_DEFS = TOOL_DEFS.filter(({ function: tool }) => !NETWORK_TOOLS.has(tool.name));

/** Network tools are opt-in: a generic prompt must never trigger a fetch. */
export function webToolsExplicitlyRequested(prompt: string): boolean {
  return /(?:\bweb\s*fetch\b|\bweb\s*search\b|\bsearch\s+the\s+web\b|\bcari\s+di\s+(?:web|internet)\b|\bfetch\s+https?:\/\/|\bopen\s+https?:\/\/|\bbuka\s+https?:\/\/|https?:\/\/\S+)/i.test(
    prompt,
  );
}

export function parseStudioToolArgs(argsText: string): Record<string, unknown> | { error: string } {
  try {
    const parsed: unknown = JSON.parse(argsText || "{}");
    return isRecord(parsed) ? parsed : { error: "arguments must be a JSON object" };
  } catch {
    return { error: "arguments must be valid JSON" };
  }
}

/** Evaluates a pure arithmetic expression without `eval`.
 *
 * A tiny recursive-descent parser over `+ - * / % **` and parentheses. `eval`
 * would run arbitrary code in the page's own context; this only ever produces a
 * number, and rejects anything it does not understand. */
export function evaluateArithmetic(expression: string): number {
  const src = expression.replace(/\s+/g, "");
  if (src.length === 0) throw new Error("empty expression");
  let i = 0;

  const peek = (): string => src[i] ?? "";
  const eat = (token: string): boolean => {
    if (src.startsWith(token, i)) {
      i += token.length;
      return true;
    }
    return false;
  };

  // expr := term (('+'|'-') term)*
  const parseExpr = (): number => {
    let value = parseTerm();
    for (;;) {
      if (eat("+")) value += parseTerm();
      else if (eat("-")) value -= parseTerm();
      else return value;
    }
  };
  // term := unary (('*'|'/'|'%') unary)*
  const parseTerm = (): number => {
    let value = parseUnary();
    for (;;) {
      if (eat("*")) value *= parseUnary();
      else if (eat("/")) {
        const d = parseUnary();
        if (d === 0) throw new Error("division by zero");
        value /= d;
      } else if (eat("%")) {
        const d = parseUnary();
        if (d === 0) throw new Error("modulo by zero");
        value %= d;
      } else return value;
    }
  };
  // unary := ('+'|'-') unary | power
  const parseUnary = (): number => {
    if (eat("+")) return parseUnary();
    if (eat("-")) return -parseUnary();
    return parsePower();
  };
  // power := primary ('**' unary)?   (right-associative)
  const parsePower = (): number => {
    const base = parsePrimary();
    if (eat("**")) return base ** parseUnary();
    return base;
  };
  const parsePrimary = (): number => {
    if (eat("(")) {
      const value = parseExpr();
      if (!eat(")")) throw new Error("missing closing parenthesis");
      return value;
    }
    const match = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!match) throw new Error(`unexpected token at position ${i}: "${peek()}"`);
    i += match[0].length;
    return Number(match[0]);
  };

  const result = parseExpr();
  if (i !== src.length) throw new Error(`unexpected trailing input: "${src.slice(i)}"`);
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}

/** Reads a path out of parsed JSON: `a.b[0].c`. */
export function queryJsonPath(root: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed.length === 0) return root;
  const tokens = trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((part) => part.length > 0);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      throw new Error(`path "${path}" hit ${current === null ? "null" : "undefined"} at "${token}"`);
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`index ${token} is out of range (length ${current.length})`);
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object") throw new Error(`cannot read "${token}" from a ${typeof current}`);
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** Executes one local Studio tool synchronously. */
export function executeStudioTool(name: string, argsText: string): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  if (name === "printf") {
    const text = args["text"];
    if (typeof text !== "string") return JSON.stringify({ error: "printf requires {text: string}" });
    return JSON.stringify({ output: text });
  }
  if (name === "clock") {
    const now = new Date();
    return JSON.stringify({ iso: now.toISOString(), local: now.toString() });
  }
  if (name === "calculate") {
    const expression = args["expression"];
    if (typeof expression !== "string") {
      return JSON.stringify({ error: "calculate requires {expression: string}" });
    }
    try {
      const value = evaluateArithmetic(expression);
      return JSON.stringify({ expression, value });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : "invalid expression" });
    }
  }
  if (name === "json_query") {
    const json = args["json"];
    if (typeof json !== "string") return JSON.stringify({ error: "json_query requires {json: string}" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return JSON.stringify({ error: `json is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}` });
    }
    try {
      const value = queryJsonPath(parsed, typeof args["path"] === "string" ? args["path"] : "");
      return JSON.stringify({ value });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : "invalid path" });
    }
  }
  if (name === "base64") {
    const mode = args["mode"];
    const text = args["text"];
    if (typeof text !== "string") return JSON.stringify({ error: "base64 requires {text: string}" });
    try {
      if (mode === "encode") {
        // btoa needs latin1; route UTF-8 through TextEncoder so non-ASCII survives.
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return JSON.stringify({ result: btoa(binary) });
      }
      if (mode === "decode") {
        const binary = atob(text.trim());
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return JSON.stringify({ result: new TextDecoder().decode(bytes) });
      }
      return JSON.stringify({ error: "mode must be 'encode' or 'decode'" });
    } catch {
      return JSON.stringify({ error: mode === "decode" ? "input is not valid base64" : "could not encode" });
    }
  }
  if (name === "render_mermaid") {
    const code = args["code"];
    return typeof code === "string"
      ? JSON.stringify({ ascii: mermaidToAscii(code) })
      : JSON.stringify({ error: "render_mermaid requires {code: string}" });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

export function mermaidToAscii(source: string): string {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const edges = lines.flatMap((line) => {
    const flow = line.match(/^([A-Za-z0-9_-]+)\s*--+>\s*(?:\|([^|]*)\|\s*)?([A-Za-z0-9_-]+)/);
    if (flow) return [`${flow[1]}${flow[2] ? ` -[${flow[2]}]->` : " -->"} ${flow[3]}`];
    const sequence = line.match(/^([A-Za-z0-9_-]+)\s*[-=]+>>\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    return sequence ? [`${sequence[1]} -> ${sequence[2]}: ${sequence[3]}`] : [];
  });
  return edges.length > 0 ? edges.join("\n") : lines.join("\n");
}

/** Executes local, sandboxed, or backend-backed Studio tools.
 *
 * `studioKey` is the caller's already-resolved gateway key. It is passed in
 * rather than fetched here so a tool call never races the composer's own key
 * bootstrap, and so this module stays free of React state. */
export async function executeStudioToolAsync(
  name: string,
  argsText: string,
  signal?: AbortSignal,
  allowWeb = false,
  studioKey?: string | null,
): Promise<string> {
  if (name === "run_javascript") {
    const args = parseStudioToolArgs(argsText);
    if ("error" in args) return JSON.stringify(args);
    const code = args["code"];
    if (typeof code !== "string" || code.trim().length === 0) {
      return JSON.stringify({ error: "run_javascript requires {code: string}" });
    }
    const outcome = await runInSandbox(code, typeof args["input"] === "string" ? args["input"] : undefined);
    return JSON.stringify(outcome.ok ? { result: outcome.result } : { error: outcome.error });
  }
  if (name === "web_search") {
    if (!allowWeb) return JSON.stringify({ error: "web search requires an explicit web request" });
    const args = parseStudioToolArgs(argsText);
    if ("error" in args) return JSON.stringify(args);
    const query = args["query"];
    if (typeof query !== "string" || query.trim().length === 0) {
      return JSON.stringify({ error: "web_search requires {query: string}" });
    }
    return runWebSearch(query, args["max_results"], studioKey, signal);
  }
  if (name !== "web_fetch") return executeStudioTool(name, argsText);
  if (!allowWeb) return JSON.stringify({ error: "web fetch requires an explicit web request" });
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const endpoint = "/console/api/studio/web-fetch";
  const body = { url: args["url"], maxChars: args["maxChars"] };
  try {
    const csrf = readConsoleCsrfCookie();
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return JSON.stringify(response.ok ? payload : { error: payload });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "web tool request failed" });
  }
}

/** Normalized shape the gateway returns for a search hit. */
interface SearchHit {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly content?: string;
}

/** The search provider the Studio key should route through.
 *
 * The gateway's `/v1/search` route resolves a `model` through the same routing
 * engine as chat, so an alias or combo of search providers works too. The
 * default names a plain search model; when no search provider is configured the
 * route answers 503 and the model is told to fall back on what it knows. */
const SEARCH_MODEL = "brave-search";

/** Runs a web search through the gateway's native `/v1/search` route.
 *
 * Reuses the Studio key (which carries `search:invoke`) rather than a separate
 * credential, so a search bills and audits like any other request the operator
 * makes from this page. */
async function runWebSearch(
  query: string,
  maxResults: unknown,
  studioKey: string | null | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const count =
    typeof maxResults === "number" && Number.isFinite(maxResults)
      ? Math.max(1, Math.min(10, Math.floor(maxResults)))
      : 5;
  const body = { model: SEARCH_MODEL, query, max_results: count };
  try {
    if (!studioKey) return JSON.stringify({ error: "no gateway key available for search" });
    const response = await fetch("/v1/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${studioKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) return JSON.stringify({ error: payload });
    // The route returns a normalized envelope; surface only the fields a model
    // can use, so a provider's raw payload never floods the context.
    const results = (isRecord(payload) && Array.isArray(payload.results) ? payload.results : [])
      .slice(0, count)
      .map((hit: SearchHit) => ({
        title: hit.title ?? "",
        url: hit.url ?? "",
        snippet: (hit.snippet ?? hit.content ?? "").slice(0, 500),
      }));
    return JSON.stringify({ query, results });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "web search request failed" });
  }
}
