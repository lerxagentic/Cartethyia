/**
 * The Model Lab playground tools.
 *
 * The interesting properties are the ones where a model — not a trusted caller —
 * supplies the input:
 *
 * - **`calculate` never evaluates.** It parses arithmetic itself, so an
 *   expression that is actually code (`process.exit()`, `alert(1)`) must be
 *   rejected rather than run. This is the whole reason it is not `eval`.
 * - **`json_query` cannot walk into prototypes.** A path like `__proto__` or
 *   `constructor` must not reach an object's prototype, and an out-of-range
 *   index is an error rather than `undefined` the model would read as "absent".
 * - **Network tools stay opt-in.** `web_fetch`/`web_search` must not be handed
 *   to the model for a prompt that never asked for the web, or a generic
 *   question would silently make outbound requests.
 * - **`base64` round-trips non-ASCII**, which the naive `btoa` path mangles.
 */
import { describe, expect, test } from "bun:test";
import {
  LOCAL_TOOL_DEFS,
  MAX_TOOL_TURNS,
  TOOL_DEFS,
  evaluateArithmetic,
  executeStudioTool,
  queryJsonPath,
  webToolsExplicitlyRequested,
} from "../../dashboard/src/routes/model-lab/tools";

describe("studio calculate", () => {
  test("evaluates arithmetic with precedence and parentheses", () => {
    expect(evaluateArithmetic("2 + 3 * 4")).toBe(14);
    expect(evaluateArithmetic("(2 + 3) * 4")).toBe(20);
    expect(evaluateArithmetic("10 / 4")).toBe(2.5);
    expect(evaluateArithmetic("7 % 3")).toBe(1);
    expect(evaluateArithmetic("2 ** 10")).toBe(1024);
    expect(evaluateArithmetic("-3 + 5")).toBe(2);
  });

  test("power is right-associative, matching maths", () => {
    // 2 ** (3 ** 2) = 2 ** 9, not (2 ** 3) ** 2 = 64.
    expect(evaluateArithmetic("2 ** 3 ** 2")).toBe(512);
  });

  test("refuses code, identifiers, and function calls", () => {
    for (const bad of ["process.exit()", "alert(1)", "a + b", "Math.max(1,2)", "1; 2"]) {
      expect(() => evaluateArithmetic(bad)).toThrow();
    }
  });

  test("refuses division by zero rather than returning Infinity", () => {
    expect(() => evaluateArithmetic("1 / 0")).toThrow();
    expect(() => evaluateArithmetic("1 % 0")).toThrow();
  });

  test("refuses malformed input", () => {
    expect(() => evaluateArithmetic("")).toThrow();
    expect(() => evaluateArithmetic("(1 + 2")).toThrow();
    expect(() => evaluateArithmetic("1 +")).toThrow();
  });

  test("the tool wraps the result as JSON", () => {
    const out = JSON.parse(executeStudioTool("calculate", '{"expression":"6*7"}'));
    expect(out.value).toBe(42);
  });

  test("a bad expression comes back as an error field, not a thrown tool", () => {
    const out = JSON.parse(executeStudioTool("calculate", '{"expression":"boom()"}'));
    expect(typeof out.error).toBe("string");
  });
});

describe("studio json_query", () => {
  const doc = { data: { items: [{ name: "a" }, { name: "b" }] } };

  test("reads nested keys and array indexes", () => {
    expect(queryJsonPath(doc, "data.items[0].name")).toBe("a");
    expect(queryJsonPath(doc, "data.items.1.name")).toBe("b");
    expect(queryJsonPath(doc, "")).toEqual(doc);
  });

  test("an out-of-range index is an error, not undefined", () => {
    expect(() => queryJsonPath(doc, "data.items[9]")).toThrow();
  });

  test("a path through a scalar is an error", () => {
    expect(() => queryJsonPath(doc, "data.items[0].name.deeper")).toThrow();
  });

  test("the tool reports an invalid path as an error field", () => {
    const out = JSON.parse(executeStudioTool("json_query", '{"json":"{\\"a\\":1}","path":"b.c"}'));
    expect(typeof out.error).toBe("string");
  });

  test("invalid JSON is reported, not thrown", () => {
    const out = JSON.parse(executeStudioTool("json_query", '{"json":"{oops","path":"a"}'));
    expect(out.error).toContain("not valid JSON");
  });
});

describe("studio base64", () => {
  test("round-trips non-ASCII text", () => {
    const encoded = JSON.parse(executeStudioTool("base64", '{"mode":"encode","text":"héllo → 世界"}'));
    expect(encoded.result).toBeTruthy();
    const decoded = JSON.parse(
      executeStudioTool("base64", JSON.stringify({ mode: "decode", text: encoded.result })),
    );
    expect(decoded.result).toBe("héllo → 世界");
  });

  test("an invalid decode is an error field", () => {
    const out = JSON.parse(executeStudioTool("base64", '{"mode":"decode","text":"!!!not base64!!!"}'));
    expect(typeof out.error).toBe("string");
  });
});

describe("studio tool gating", () => {
  test("network tools are withheld from a prompt that never asked for the web", () => {
    const names = LOCAL_TOOL_DEFS.map((d) => d.function.name);
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_search");
    // Sandbox and pure-local tools stay available.
    expect(names).toContain("run_javascript");
    expect(names).toContain("calculate");
  });

  test("the turn budget allows a multi-step coding loop", () => {
    // A read → compute → fix → verify cycle needs more than a chat-sized budget;
    // five turns ran out mid-task.
    expect(MAX_TOOL_TURNS).toBeGreaterThanOrEqual(10);
  });

  test("the full set contains every declared tool", () => {
    const names = TOOL_DEFS.map((d) => d.function.name).sort();
    expect(names).toEqual(
      ["base64", "calculate", "clock", "json_query", "printf", "render_mermaid", "run_javascript", "web_fetch", "web_search"],
    );
  });

  test("an explicit web request arms the network tools", () => {
    for (const prompt of [
      "web search for the latest news",
      "search the web for X",
      "buka https://example.com",
      "fetch https://example.com",
      "cari di web tentang harga emas",
      "what does https://example.com say",
    ]) {
      expect(webToolsExplicitlyRequested(prompt)).toBe(true);
    }
  });

  test("an ordinary question does not arm them", () => {
    for (const prompt of ["write a haiku", "explain TCP", "compute 2+2", "ringkas teks ini"]) {
      expect(webToolsExplicitlyRequested(prompt)).toBe(false);
    }
  });
});
