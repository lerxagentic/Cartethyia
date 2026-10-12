import { isRecord, readConsoleCsrfCookie } from "../../data/api";
import type { StudioAttachment } from "../../data/contracts";
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
        maxChars: { type: "integer", minimum: 1000, maximum: 60000 },
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
    description:
      "Draw a Mermaid diagram (flowchart, sequence, class, state, ER) and show it to the user as a picture. Return the Mermaid source; the transcript renders it. Use this whenever a diagram explains the answer better than prose.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Mermaid diagram source, e.g. 'flowchart TD\\n  A-->B'" },
      },
      required: ["code"],
    },
  },
  {
    name: "diff_text",
    description:
      "Compare two texts and return a unified diff. Use it to show exactly what changed between versions instead of describing the change in prose.",
    parameters: {
      type: "object",
      properties: {
        before: { type: "string", description: "The original text" },
        after: { type: "string", description: "The changed text" },
        context: { type: "integer", minimum: 0, maximum: 10, description: "Context lines (default 3)" },
      },
      required: ["before", "after"],
    },
  },
  {
    name: "regex_extract",
    description:
      "Run a regular expression over text and return every match with its capture groups. Use it to pull structured values out of unstructured text.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source, e.g. '(\\\\d{4})-(\\\\d{2})'" },
        text: { type: "string", description: "Text to search" },
        flags: { type: "string", description: "Regex flags, e.g. 'gi' (default 'g')" },
      },
      required: ["pattern", "text"],
    },
  },
  {
    name: "hash_text",
    description:
      "Compute a hash or generate an id: sha256/sha1/md5 of text, a random UUID v4, or random bytes. Use it for checksums, ids, and sample data.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["sha256", "sha1", "md5", "uuid", "random"] },
        text: { type: "string", description: "Text to hash (required for the hash modes)" },
        bytes: { type: "integer", minimum: 1, maximum: 64, description: "Byte count for mode 'random' (default 16)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "datetime_math",
    description:
      "Do date and time arithmetic: add or subtract a duration, diff two instants, or convert between time zones. Use it instead of counting days by hand.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["add", "diff", "convert"] },
        date: { type: "string", description: "ISO 8601 date/time, e.g. '2026-01-31T10:00:00Z'" },
        amount: { type: "integer", description: "Units to add (mode 'add'); may be negative" },
        unit: { type: "string", enum: ["seconds", "minutes", "hours", "days", "weeks", "months", "years"] },
        to: { type: "string", description: "Second ISO date for mode 'diff', or IANA zone for mode 'convert'" },
        timeZone: { type: "string", description: "IANA zone to interpret a zone-less input in, e.g. 'Asia/Jakarta'" },
      },
      required: ["mode", "date"],
    },
  },
  {
    name: "unit_convert",
    description:
      "Convert between units of the same kind: length, mass, temperature, data size, speed, or time. Use it instead of recalling conversion factors.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["length", "mass", "temperature", "data", "speed", "time"],
        },
        value: { type: "number", description: "The amount to convert" },
        from: { type: "string", description: "Source unit, e.g. 'km', 'lb', 'C', 'MB', 'kph'" },
        to: { type: "string", description: "Target unit, e.g. 'mi', 'kg', 'F', 'GiB', 'mph'" },
      },
      required: ["kind", "value", "from", "to"],
    },
  },
  {
    name: "render_chart",
    description:
      "Draw a bar, line, or pie chart from data and show it to the user. Use it when a chart communicates the answer better than a table.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line", "pie"] },
        title: { type: "string", description: "Chart title" },
        labels: { type: "array", items: { type: "string" }, description: "Category labels, one per value" },
        values: { type: "array", items: { type: "number" }, description: "Numeric values, same length as labels" },
      },
      required: ["type", "labels", "values"],
    },
  },
  {
    name: "http_request",
    description:
      "Call an HTTP API with a method, headers, and a body (GET, POST, PUT, PATCH, DELETE). Use it for JSON APIs the user asks you to hit; for reading a web page prefer web_fetch.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string", description: "Absolute http(s) URL" },
        headers: { type: "object", description: "Request headers, e.g. {\"content-type\":\"application/json\"}" },
        body: { type: "string", description: "Request body (JSON string, form-encoded, or plain text)" },
      },
      required: ["method", "url"],
    },
  },
  {
    name: "csv_query",
    description:
      "Read a CSV attachment: list its columns, show the first rows, or aggregate a numeric column (sum/avg/min/max/count). Use it for any CSV the user attached instead of guessing at its contents.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Attachment file name; omit to use the first CSV attached" },
        operation: { type: "string", enum: ["columns", "rows", "aggregate"] },
        column: { type: "string", description: "Column name for operation 'aggregate'" },
        agg: { type: "string", enum: ["sum", "avg", "min", "max", "count"] },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Row count for operation 'rows' (default 20)" },
      },
      required: ["operation"],
    },
  },
  {
    name: "file_read",
    description:
      "Read the text of an attachment the user uploaded (txt, md, json, csv, xml, log, source code, …). Use it to work with a file's actual contents.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Attachment file name; omit to use the first readable attachment" },
        maxChars: { type: "integer", minimum: 1000, maximum: 100000, description: "Cap (default 40000)" },
      },
      required: [],
    },
  },
] as const;

export const MAX_TOOL_TURNS = 12;

/** Tools that reach the network. They are opt-in per prompt, never armed by
 *  default, so a generic question cannot silently trigger a fetch or a search. */
export const NETWORK_TOOL_NAMES = ["web_fetch", "web_search", "http_request"] as const;

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

/** Whether the prompt asks for something the model cannot know by itself.
 *
 * Two independent signals arm the network tools:
 *
 * 1. An explicit request — "web search", "fetch <url>", a bare URL.
 * 2. A recency intent — "today", "current price", "latest news", "harga emas
 *    hari ini". A model asked for today's gold price has no way to answer
 *    without a search, and withholding the tool leaves it apologising instead
 *    of looking. This is still narrow: a timeless question ("explain TCP",
 *    "write a haiku") matches neither signal and stays offline.
 *
 * Arming is not the same as calling: the model still decides whether to use the
 * tool, so a false positive costs a tool definition in the request, not an
 * outbound fetch.
 */
export function webToolsRequested(prompt: string): boolean {
  if (/(?:\bweb\s*fetch\b|\bweb\s*search\b|\bsearch\s+the\s+web\b|\bcari\s+di\s+(?:web|internet)\b|\bfetch\s+https?:\/\/|\bopen\s+https?:\/\/|\bbuka\s+https?:\/\/|https?:\/\/\S+)/i.test(prompt)) {
    return true;
  }
  // Recency intent: the answer depends on data that changed after training.
  return /(?:\btoday\b|\btonight\b|\bnow\b|\bcurrent(?:ly)?\b|\blatest\b|\brecent(?:ly)?\b|\bthis\s+(?:week|month|year)\b|\bright\s+now\b|\bnews\b|\bhari\s+ini\b|\bsekarang\b|\bsaat\s+ini\b|\bterkini\b|\bterbaru\b|\bberita\b|\bkabar\s+terbaru\b|\bharga\s+\S+\s+(?:hari\s+ini|sekarang|terkini)\b|\bupdate\s+terbaru\b)/i.test(
    prompt,
  );
}

/** @deprecated Use {@link webToolsRequested}; kept for callers that predate the
 *  recency signal. */
export const webToolsExplicitlyRequested = webToolsRequested;

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

/** Text-like mimes `file_read` can decode. A binary attachment (an image, a PDF
 *  body) is not text and must not be dumped into the model's context. */
const TEXT_MIME_PATTERN = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|javascript|typescript|sql|graphql)|image\/svg)/i;
const TEXT_EXTENSIONS = /\.(?:txt|md|markdown|json|jsonl|csv|tsv|xml|ya?ml|log|ini|toml|env|sh|py|js|jsx|ts|tsx|css|html?|sql|go|rs|java|c|cpp|h|rb|php|swift|kt)$/i;

/** Decodes a `data:` URL's payload as UTF-8 text. */
function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "";
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64$/i.test(meta) || /;base64;/i.test(meta)) {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}

function pickAttachment(
  attachments: readonly StudioAttachment[] | undefined,
  wanted: unknown,
  predicate: (a: StudioAttachment) => boolean,
): StudioAttachment | undefined {
  const list = attachments ?? [];
  if (typeof wanted === "string" && wanted.trim().length > 0) {
    return list.find((a) => a.name === wanted) ?? list.find((a) => a.name.includes(wanted));
  }
  return list.find(predicate);
}

/** `file_read`: returns the text of an uploaded attachment. */
function runFileRead(argsText: string, attachments?: readonly StudioAttachment[]): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const attachment = pickAttachment(
    attachments,
    args["file"],
    (a) => TEXT_MIME_PATTERN.test(a.mime) || TEXT_EXTENSIONS.test(a.name),
  );
  if (!attachment) {
    const names = (attachments ?? []).map((a) => a.name).join(", ") || "none";
    return JSON.stringify({ error: `no readable text attachment (attached: ${names})` });
  }
  const cap =
    typeof args["maxChars"] === "number" && Number.isFinite(args["maxChars"])
      ? Math.max(1000, Math.min(100_000, Math.floor(args["maxChars"])))
      : 40_000;
  let text: string;
  try {
    text = decodeDataUrlText(attachment.dataUrl);
  } catch {
    return JSON.stringify({ error: `${attachment.name} could not be decoded as text` });
  }
  return JSON.stringify({
    file: attachment.name,
    mime: attachment.mime,
    chars: text.length,
    truncated: text.length > cap,
    content: text.slice(0, cap),
  });
}

/** Splits one CSV line, honouring double-quoted fields with embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Parses CSV text into a header row plus records. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0] ?? "");
  const rows = lines.slice(1).map(splitCsvLine);
  return { headers, rows };
}

/** `csv_query`: columns, sample rows, or a numeric aggregate over one column. */
function runCsvQuery(argsText: string, attachments?: readonly StudioAttachment[]): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const attachment = pickAttachment(
    attachments,
    args["file"],
    (a) => a.mime.includes("csv") || /\.(?:csv|tsv)$/i.test(a.name),
  );
  if (!attachment) {
    const names = (attachments ?? []).map((a) => a.name).join(", ") || "none";
    return JSON.stringify({ error: `no CSV attachment (attached: ${names})` });
  }
  let parsed: { headers: string[]; rows: string[][] };
  try {
    const text = decodeDataUrlText(attachment.dataUrl).replace(/\t/g, ",");
    parsed = parseCsv(text);
  } catch {
    return JSON.stringify({ error: `${attachment.name} could not be decoded as CSV` });
  }
  const { headers, rows } = parsed;
  if (headers.length === 0) return JSON.stringify({ error: "the CSV is empty" });
  const operation = args["operation"];

  if (operation === "columns") {
    return JSON.stringify({ file: attachment.name, rows: rows.length, columns: headers });
  }
  if (operation === "rows") {
    const limit =
      typeof args["limit"] === "number" && Number.isFinite(args["limit"])
        ? Math.max(1, Math.min(100, Math.floor(args["limit"])))
        : 20;
    return JSON.stringify({
      file: attachment.name,
      total_rows: rows.length,
      rows: rows.slice(0, limit).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))),
    });
  }
  if (operation === "aggregate") {
    const column = typeof args["column"] === "string" ? args["column"] : "";
    const index = headers.indexOf(column);
    if (index < 0) return JSON.stringify({ error: `column "${column}" not found`, columns: headers });
    const numbers = rows
      .map((row) => Number((row[index] ?? "").replace(/,/g, "")))
      .filter((n) => Number.isFinite(n));
    if (numbers.length === 0) return JSON.stringify({ error: `column "${column}" has no numeric values` });
    const sum = numbers.reduce((a, b) => a + b, 0);
    const agg = typeof args["agg"] === "string" ? args["agg"] : "sum";
    const value =
      agg === "sum" ? sum
      : agg === "avg" ? sum / numbers.length
      : agg === "min" ? Math.min(...numbers)
      : agg === "max" ? Math.max(...numbers)
      : numbers.length;
    return JSON.stringify({ file: attachment.name, column, agg, value, numeric_rows: numbers.length });
  }
  return JSON.stringify({ error: "operation must be 'columns', 'rows', or 'aggregate'" });
}

/** `datetime_math`: add a duration, diff two instants, or convert a zone. */
function runDatetimeMath(argsText: string): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const mode = args["mode"];
  const rawDate = args["date"];
  if (typeof rawDate !== "string" || rawDate.trim().length === 0) {
    return JSON.stringify({ error: "datetime_math requires {date: string}" });
  }
  const base = new Date(rawDate);
  if (Number.isNaN(base.getTime())) {
    return JSON.stringify({ error: `"${rawDate}" is not a valid ISO 8601 date` });
  }

  if (mode === "diff") {
    const to = args["to"];
    if (typeof to !== "string") return JSON.stringify({ error: "mode 'diff' requires {to: string}" });
    const other = new Date(to);
    if (Number.isNaN(other.getTime())) return JSON.stringify({ error: `"${to}" is not a valid date` });
    const ms = other.getTime() - base.getTime();
    return JSON.stringify({
      from: base.toISOString(),
      to: other.toISOString(),
      milliseconds: ms,
      seconds: ms / 1000,
      minutes: ms / 60_000,
      hours: ms / 3_600_000,
      days: ms / 86_400_000,
    });
  }

  if (mode === "convert") {
    const zone = args["to"];
    if (typeof zone !== "string") return JSON.stringify({ error: "mode 'convert' requires {to: '<IANA zone>'}" });
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        dateStyle: "short",
        timeStyle: "long",
      }).format(base);
    } catch {
      return JSON.stringify({ error: `"${zone}" is not a recognised IANA time zone` });
    }
    return JSON.stringify({ instant: base.toISOString(), timeZone: zone, formatted });
  }

  if (mode === "add") {
    const amount = args["amount"];
    const unit = args["unit"];
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return JSON.stringify({ error: "mode 'add' requires a numeric {amount}" });
    }
    const next = new Date(base.getTime());
    switch (unit) {
      case "seconds": next.setUTCSeconds(next.getUTCSeconds() + amount); break;
      case "minutes": next.setUTCMinutes(next.getUTCMinutes() + amount); break;
      case "hours": next.setUTCHours(next.getUTCHours() + amount); break;
      case "days": next.setUTCDate(next.getUTCDate() + amount); break;
      case "weeks": next.setUTCDate(next.getUTCDate() + amount * 7); break;
      case "months": next.setUTCMonth(next.getUTCMonth() + amount); break;
      case "years": next.setUTCFullYear(next.getUTCFullYear() + amount); break;
      default:
        return JSON.stringify({ error: "unit must be seconds, minutes, hours, days, weeks, months, or years" });
    }
    return JSON.stringify({ from: base.toISOString(), to: next.toISOString() });
  }
  return JSON.stringify({ error: "mode must be 'add', 'diff', or 'convert'" });
}

/** Conversion factors to a per-kind base unit. Temperature is affine, not a
 *  ratio, so it is handled separately rather than in this table. */
const UNIT_TABLE: Record<string, { base: Record<string, number> }> = {
  length: {
    base: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  },
  mass: {
    base: { kg: 1, g: 0.001, mg: 0.000001, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 },
  },
  data: {
    // Binary and decimal spellings are both accepted and kept distinct: GiB is
    // not GB, and collapsing them is a silent 7% error.
    base: {
      b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
      kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, pib: 1125899906842624,
    },
  },
  speed: { base: { mps: 1, kph: 1 / 3.6, mph: 0.44704, kn: 0.514444, fps: 0.3048 } },
  time: {
    base: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800, mo: 2629800, yr: 31557600 },
  },
};

/** `unit_convert`: ratio conversions plus the three affine temperature scales. */
function runUnitConvert(argsText: string): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const kind = args["kind"];
  const value = args["value"];
  const from = typeof args["from"] === "string" ? args["from"].toLowerCase() : "";
  const to = typeof args["to"] === "string" ? args["to"].toLowerCase() : "";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return JSON.stringify({ error: "unit_convert requires a numeric {value}" });
  }

  if (kind === "temperature") {
    const toKelvin: Record<string, (v: number) => number> = {
      c: (v) => v + 273.15,
      celsius: (v) => v + 273.15,
      f: (v) => (v + 459.67) * (5 / 9),
      fahrenheit: (v) => (v + 459.67) * (5 / 9),
      k: (v) => v,
      kelvin: (v) => v,
      r: (v) => v * (5 / 9),
      rankine: (v) => v * (5 / 9),
    };
    const fromFn = toKelvin[from];
    if (!fromFn) return JSON.stringify({ error: `unknown temperature unit "${from}"` });
    const kelvin = fromFn(value);
    const fromKelvin: Record<string, (k: number) => number> = {
      c: (k) => k - 273.15,
      celsius: (k) => k - 273.15,
      f: (k) => k * (9 / 5) - 459.67,
      fahrenheit: (k) => k * (9 / 5) - 459.67,
      k: (k) => k,
      kelvin: (k) => k,
      r: (k) => k * (9 / 5),
      rankine: (k) => k * (9 / 5),
    };
    const toFn = fromKelvin[to];
    if (!toFn) return JSON.stringify({ error: `unknown temperature unit "${to}"` });
    return JSON.stringify({ kind, value, from, to, result: toFn(kelvin) });
  }

  const table = typeof kind === "string" ? UNIT_TABLE[kind] : undefined;
  if (!table) {
    return JSON.stringify({ error: "kind must be length, mass, temperature, data, speed, or time" });
  }
  const fromFactor = table.base[from];
  const toFactor = table.base[to];
  if (fromFactor === undefined) {
    return JSON.stringify({ error: `unknown ${kind} unit "${from}"`, units: Object.keys(table.base) });
  }
  if (toFactor === undefined) {
    return JSON.stringify({ error: `unknown ${kind} unit "${to}"`, units: Object.keys(table.base) });
  }
  return JSON.stringify({ kind, value, from, to, result: (value * fromFactor) / toFactor });
}

/** Longest-common-subsequence line diff, then a unified-diff renderer.
 *
 * `O(n*m)` in lines, so it is capped: past a few thousand lines the table alone
 * would be hundreds of MB. A model comparing two large files gets told the pair
 * is too large rather than freezing the page. */
function lineDiff(before: readonly string[], after: readonly string[]): Array<{ type: " " | "-" | "+"; text: string }> {
  const n = before.length;
  const m = after.length;
  // dp[i][j] = LCS length of before[i..] and after[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = before[i] === after[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const out: Array<{ type: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: " ", text: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ type: "-", text: before[i] ?? "" });
      i += 1;
    } else {
      out.push({ type: "+", text: after[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "-", text: before[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "+", text: after[j] ?? "" });
    j += 1;
  }
  return out;
}

/** Renders a unified diff, collapsing unchanged runs to `context` lines. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return `(diff too large: ${a.length} vs ${b.length} lines)`;
  }
  const ops = lineDiff(a, b);
  const lines: string[] = ["--- before", "+++ after"];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.type === " ") {
      // Find the run of unchanged lines; emit a hunk header only if it sits
      // between changes (a leading/trailing run is elided entirely).
      let end = index;
      while (end < ops.length && ops[end]!.type === " ") end += 1;
      const run = ops.slice(index, end);
      const hasChangeBefore = index > 0;
      const hasChangeAfter = end < ops.length;
      if (hasChangeBefore && hasChangeAfter) {
        const head = run.slice(0, context);
        const tail = run.slice(Math.max(context, run.length - context));
        for (const line of head) lines.push(` ${line.text}`);
        if (run.length > context * 2) lines.push(`@@ ${run.length - context * 2} unchanged lines @@`);
        for (const line of tail) lines.push(` ${line.text}`);
      }
      index = end;
      continue;
    }
    lines.push(`${op.type}${op.text}`);
    index += 1;
  }
  return lines.join("\n");
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
  if (name === "diff_text") {
    const before = args["before"];
    const after = args["after"];
    if (typeof before !== "string" || typeof after !== "string") {
      return JSON.stringify({ error: "diff_text requires {before: string, after: string}" });
    }
    const context =
      typeof args["context"] === "number" && Number.isFinite(args["context"])
        ? Math.max(0, Math.min(10, Math.floor(args["context"])))
        : 3;
    return JSON.stringify({ diff: unifiedDiff(before, after, context) });
  }
  if (name === "render_mermaid") {
    const code = args["code"];
    if (typeof code !== "string" || code.trim().length === 0) {
      return JSON.stringify({ error: "render_mermaid requires {code: string}" });
    }
    // The transcript renders a ```mermaid fence as a real diagram, so the tool
    // hands the source back in exactly that shape. Rendering it to ASCII here
    // (the old behaviour) produced unreadable output for anything larger than a
    // three-node flow and threw away the layout Mermaid would have drawn.
    return JSON.stringify({
      rendered: "shown to the user as a diagram",
      mermaid: `\`\`\`mermaid\n${code}\n\`\`\``,
    });
  }
  if (name === "render_chart") {
    const labels = args["labels"];
    const values = args["values"];
    const chartType = args["type"];
    if (!Array.isArray(labels) || !Array.isArray(values)) {
      return JSON.stringify({ error: "render_chart requires {labels: string[], values: number[]}" });
    }
    if (labels.length === 0 || labels.length !== values.length) {
      return JSON.stringify({ error: "labels and values must be non-empty and the same length" });
    }
    const numbers = values.map((v) => (typeof v === "number" ? v : Number(v)));
    if (numbers.some((n) => !Number.isFinite(n))) {
      return JSON.stringify({ error: "every value must be a number" });
    }
    const kind = chartType === "line" || chartType === "pie" ? chartType : "bar";
    // A ```chart fence the transcript draws, same contract as render_mermaid.
    return JSON.stringify({
      rendered: "shown to the user as a chart",
      chart: `\`\`\`chart\n${JSON.stringify({
        type: kind,
        title: typeof args["title"] === "string" ? args["title"] : "",
        labels: labels.map(String),
        values: numbers,
      })}\n\`\`\``,
    });
  }
  if (name === "regex_extract") {
    const pattern = args["pattern"];
    const text = args["text"];
    if (typeof pattern !== "string" || typeof text !== "string") {
      return JSON.stringify({ error: "regex_extract requires {pattern: string, text: string}" });
    }
    let regex: RegExp;
    try {
      const flags = typeof args["flags"] === "string" ? args["flags"].replace(/[^gimsuy]/g, "") : "g";
      regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
    } catch (error) {
      return JSON.stringify({ error: `invalid pattern: ${error instanceof Error ? error.message : "parse failed"}` });
    }
    const matches: Array<{ match: string; groups: string[]; index: number }> = [];
    // Bound the loop: a pattern like `(a*)*` can match empty forever, and a
    // model-authored pattern must not be able to hang the page.
    for (let i = 0; i < 1000; i += 1) {
      const found = regex.exec(text);
      if (!found) break;
      matches.push({ match: found[0], groups: found.slice(1).map((g) => g ?? ""), index: found.index });
      if (found[0] === "") regex.lastIndex += 1;
    }
    return JSON.stringify({ count: matches.length, matches: matches.slice(0, 200) });
  }
  if (name === "hash_text") {
    const mode = args["mode"];
    if (mode === "uuid") {
      return JSON.stringify({ uuid: crypto.randomUUID() });
    }
    if (mode === "random") {
      const count =
        typeof args["bytes"] === "number" && Number.isFinite(args["bytes"])
          ? Math.max(1, Math.min(64, Math.floor(args["bytes"])))
          : 16;
      const bytes = crypto.getRandomValues(new Uint8Array(count));
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return JSON.stringify({ bytes: count, hex, base64: btoa(String.fromCharCode(...bytes)) });
    }
    const text = args["text"];
    if (typeof text !== "string") {
      return JSON.stringify({ error: `hash_text mode "${String(mode)}" requires {text: string}` });
    }
    // WebCrypto exposes SHA-1/SHA-256 but not MD5; rather than ship an MD5
    // implementation for a checksum nobody should rely on, the mode is refused
    // with a pointer to the supported ones.
    if (mode === "md5") {
      return JSON.stringify({ error: "md5 is not supported; use sha1 or sha256" });
    }
    if (mode !== "sha1" && mode !== "sha256") {
      return JSON.stringify({ error: "mode must be sha256, sha1, uuid, or random" });
    }
    // The async path in `executeStudioToolAsync` computes the digest; reaching
    // here means a caller used the synchronous entry point for a hash.
    return JSON.stringify({ error: "use executeStudioToolAsync for hashing" });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

/** Executes local, sandboxed, or backend-backed Studio tools.
 *
 * `studioKey` is the caller's already-resolved gateway key. It is passed in
 * rather than fetched here so a tool call never races the composer's own key
 * bootstrap, and so this module stays free of React state.
 *
 * `attachments` are the files on the message being sent, so `file_read` and
 * `csv_query` can work on what the operator actually uploaded rather than
 * asking the model to paste contents it cannot see. */
export async function executeStudioToolAsync(
  name: string,
  argsText: string,
  signal?: AbortSignal,
  allowWeb = false,
  studioKey?: string | null,
  attachments?: readonly StudioAttachment[],
): Promise<string> {
  if (name === "hash_text") {
    const args = parseStudioToolArgs(argsText);
    if ("error" in args) return JSON.stringify(args);
    const mode = args["mode"];
    if (mode === "sha1" || mode === "sha256") {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      const bytes = new TextEncoder().encode(text);
      // WebCrypto is the portable path, but `crypto.subtle` is absent under
      // some test runners and older browsers. Bun exposes the same digests
      // synchronously, so it is used as the fallback rather than shipping a
      // hand-rolled hash.
      let hex: string;
      const subtle = globalThis.crypto?.subtle;
      const bunCrypto = (globalThis as { Bun?: { CryptoHasher?: new (alg: string) => { update(d: Uint8Array): void; digest(enc: string): string } } }).Bun?.CryptoHasher;
      if (subtle) {
        const digest = await subtle.digest(mode === "sha1" ? "SHA-1" : "SHA-256", bytes);
        hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      } else if (bunCrypto) {
        const hasher = new bunCrypto(mode === "sha1" ? "sha1" : "sha256");
        hasher.update(bytes);
        hex = hasher.digest("hex");
      } else {
        return JSON.stringify({ error: "no SHA implementation available in this environment" });
      }
      return JSON.stringify({ mode, hex });
    }
    // uuid / random / errors are handled synchronously below.
    return executeStudioTool("hash_text", argsText);
  }
  if (name === "datetime_math") return runDatetimeMath(argsText);
  if (name === "unit_convert") return runUnitConvert(argsText);
  if (name === "file_read") return runFileRead(argsText, attachments);
  if (name === "csv_query") return runCsvQuery(argsText, attachments);
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
  if (name === "http_request") {
    if (!allowWeb) return JSON.stringify({ error: "http_request requires an explicit web request" });
    return runHttpRequest(argsText, signal);
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

/** `http_request`: sends method/headers/body through the backend.
 *
 * The call cannot go from the browser directly: a cross-origin API without CORS
 * headers would fail, and letting the page make arbitrary requests would bypass
 * the SSRF validation the backend fetcher applies. So it takes the same route as
 * `web_fetch` — through the console, which validates the URL and strips headers
 * the model must not control. */
async function runHttpRequest(argsText: string, signal?: AbortSignal): Promise<string> {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const url = args["url"];
  const method = args["method"];
  if (typeof url !== "string" || url.trim().length === 0) {
    return JSON.stringify({ error: "http_request requires {url: string}" });
  }
  if (typeof method !== "string") {
    return JSON.stringify({ error: "http_request requires {method: string}" });
  }
  const csrf = readConsoleCsrfCookie();
  try {
    const response = await fetch("/console/api/studio/http-request", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify({
        method,
        url,
        headers: isRecord(args["headers"]) ? args["headers"] : {},
        body: args["body"],
      }),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return JSON.stringify(response.ok ? payload : { error: payload });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "http request failed" });
  }
}

/** Normalized shape the gateway returns for a search hit. */
interface SearchHit {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly content?: string;
}

/** Search models to try, in order.
 *
 * The gateway's `/v1/search` route resolves a `model` through the same routing
 * engine as chat. Each id below is one provider's search model, and a provider
 * with no credential answers "no eligible search route" — so the chain is tried
 * in turn rather than pinning one provider. That way a deployment with only Exa
 * configured still gets search instead of a hard failure naming Brave. */
const SEARCH_MODEL_CHAIN = ["brave-search", "exa-search", "tavily-search"] as const;

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
  if (!studioKey) return JSON.stringify({ error: "no gateway key available for search" });

  let lastError: unknown = "no search provider configured";
  for (const model of SEARCH_MODEL_CHAIN) {
    let response: Response;
    try {
      response = await fetch("/v1/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${studioKey}`,
        },
        body: JSON.stringify({ model, query, max_results: count }),
        signal,
      });
    } catch (error) {
      // A transport failure (or the caller's abort) is not "try the next
      // provider": the request never landed, so surface it.
      return JSON.stringify({ error: error instanceof Error ? error.message : "web search request failed" });
    }
    const payload: unknown = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      lastError = payload;
      // Only a routing/admission miss is worth another provider. A 400 means the
      // request itself is wrong and would fail identically everywhere.
      if (response.status !== 503 && response.status !== 404) break;
      continue;
    }
    // The route returns a normalized envelope; surface only the fields a model
    // can use, so a provider's raw payload never floods the context.
    const results = (isRecord(payload) && Array.isArray(payload.results) ? payload.results : [])
      .slice(0, count)
      .map((hit: SearchHit) => ({
        title: hit.title ?? "",
        url: hit.url ?? "",
        snippet: (hit.snippet ?? hit.content ?? "").slice(0, 500),
      }));
    return JSON.stringify({ query, provider: model, results });
  }
  return JSON.stringify({ error: lastError });
}
