/**
 * The Model Lab's data and conversion tools.
 *
 * These take model-authored input, so the properties that matter are the ones
 * where a bad input must be refused rather than answered wrongly:
 *
 * - **`unit_convert` refuses an unknown unit.** Silently treating "foo" as a
 *   factor of 1 returns the input unchanged, which reads as a correct answer.
 * - **`datetime_math` handles month arithmetic and rejects bad dates** rather
 *   than producing `Invalid Date` the model would narrate as a real instant.
 * - **`regex_extract` is bounded.** A model-authored pattern like `(a*)*` can
 *   match the empty string forever; the loop must terminate.
 * - **`csv_query` respects quoted fields** — a comma inside `"a,b"` is data, not
 *   a column separator.
 * - **`file_read` refuses a binary attachment** instead of dumping a decoded
 *   image body into the model's context.
 * - **`hash_text` refuses md5** with a pointer to what it does support.
 */
import { describe, expect, test } from "bun:test";
import { executeStudioToolAsync, parseCsv } from "../../dashboard/src/routes/model-lab/tools";

/** Runs one tool the way the Model Lab does: through the async dispatcher,
 *  which is the entry point the app calls (hashing needs WebCrypto). */
const run = async (name: string, args: unknown, attachments?: unknown[]) =>
  JSON.parse(
    await executeStudioToolAsync(name, JSON.stringify(args), undefined, false, "k", attachments as never),
  );

/** Builds an attachment with a text payload, as the composer would. */
function textAttachment(name: string, mime: string, content: string) {
  return { kind: "file" as const, name, mime, dataUrl: `data:${mime};base64,${btoa(content)}` };
}

describe("unit_convert", () => {
  test("converts within a kind", async () => {
    expect((await run("unit_convert", { kind: "length", value: 1, from: "km", to: "m" })).result).toBeCloseTo(1000);
    expect((await run("unit_convert", { kind: "mass", value: 1, from: "kg", to: "lb" })).result).toBeCloseTo(2.20462, 4);
    expect((await run("unit_convert", { kind: "speed", value: 100, from: "kph", to: "mph" })).result).toBeCloseTo(62.137, 2);
  });

  test("keeps GiB and GB distinct", async () => {
    // Collapsing these is a silent ~7% error.
    expect((await run("unit_convert", { kind: "data", value: 1, from: "gib", to: "mb" })).result).toBeCloseTo(1073.741824, 3);
    expect((await run("unit_convert", { kind: "data", value: 1, from: "gb", to: "mb" })).result).toBe(1000);
  });

  test("handles the affine temperature scales", async () => {
    expect((await run("unit_convert", { kind: "temperature", value: 0, from: "c", to: "f" })).result).toBeCloseTo(32);
    expect((await run("unit_convert", { kind: "temperature", value: 100, from: "c", to: "f" })).result).toBeCloseTo(212);
    expect((await run("unit_convert", { kind: "temperature", value: 32, from: "f", to: "c" })).result).toBeCloseTo(0);
    expect((await run("unit_convert", { kind: "temperature", value: 0, from: "c", to: "k" })).result).toBeCloseTo(273.15);
  });

  test("an unknown unit is refused, not treated as factor 1", async () => {
    const out = (await run("unit_convert", { kind: "length", value: 5, from: "furlong", to: "m" }));
    expect(typeof out.error).toBe("string");
    expect(out.units).toContain("km");
  });

  test("an unknown kind is refused", async () => {
    expect(typeof (await run("unit_convert", { kind: "vibes", value: 1, from: "a", to: "b" })).error).toBe("string");
  });
});

describe("datetime_math", () => {
  test("adds a duration", async () => {
    const out = (await run("datetime_math", { mode: "add", date: "2026-01-31T00:00:00Z", amount: 1, unit: "days" }));
    expect(out.to).toBe("2026-02-01T00:00:00.000Z");
  });

  test("subtracts with a negative amount", async () => {
    const out = (await run("datetime_math", { mode: "add", date: "2026-03-01T00:00:00Z", amount: -1, unit: "days" }));
    expect(out.to).toBe("2026-02-28T00:00:00.000Z");
  });

  test("month arithmetic rolls over the year", async () => {
    const out = (await run("datetime_math", { mode: "add", date: "2026-12-15T00:00:00Z", amount: 1, unit: "months" }));
    expect(out.to).toBe("2027-01-15T00:00:00.000Z");
  });

  test("diffs two instants", async () => {
    const out = (await run("datetime_math", { mode: "diff", date: "2026-01-01T00:00:00Z", to: "2026-01-02T12:00:00Z" }));
    expect(out.hours).toBe(36);
    expect(out.days).toBeCloseTo(1.5);
  });

  test("a bad date is refused, not narrated as a real instant", async () => {
    expect(typeof (await run("datetime_math", { mode: "add", date: "not-a-date", amount: 1, unit: "days" })).error).toBe("string");
  });

  test("an unknown zone is refused", async () => {
    const out = (await run("datetime_math", { mode: "convert", date: "2026-01-01T00:00:00Z", to: "Mars/Olympus" }));
    expect(typeof out.error).toBe("string");
  });
});

describe("regex_extract", () => {
  test("returns matches with their capture groups", async () => {
    const out = (await run("regex_extract", { pattern: "(\\d{4})-(\\d{2})", text: "2026-01 and 2027-03" }));
    expect(out.count).toBe(2);
    expect(out.matches[0].groups).toEqual(["2026", "01"]);
  });

  test("terminates on a pattern that can match empty", async () => {
    // The bound is what keeps a model-authored pattern from hanging the page.
    const out = (await run("regex_extract", { pattern: "(a*)*", text: "aaa" }));
    expect(out.count).toBeLessThanOrEqual(1000);
  });

  test("an invalid pattern is an error field", async () => {
    expect(typeof (await run("regex_extract", { pattern: "(", text: "x" })).error).toBe("string");
  });
});

describe("hash_text", () => {
  test("sha256 matches the known digest of an empty string", async () => {
    const out = (await run("hash_text", { mode: "sha256", text: "" }));
    expect(out.hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("sha1 matches the known digest", async () => {
    const out = (await run("hash_text", { mode: "sha1", text: "abc" }));
    expect(out.hex).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("md5 is refused with a pointer to what works", async () => {
    const out = (await run("hash_text", { mode: "md5", text: "abc" }));
    expect(out.error).toContain("sha256");
  });

  test("uuid is a v4 shape", async () => {
    const out = (await run("hash_text", { mode: "uuid" }));
    expect(out.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("random honours the byte count and caps it", async () => {
    expect((await run("hash_text", { mode: "random", bytes: 8 })).bytes).toBe(8);
    expect((await run("hash_text", { mode: "random", bytes: 9999 })).bytes).toBe(64);
  });
});

describe("render_chart", () => {
  test("emits a chart fence the transcript draws", async () => {
    const out = (await run("render_chart", { type: "bar", title: "Sales", labels: ["a", "b"], values: [1, 2] }));
    expect(out.chart).toContain("```chart");
    expect(JSON.parse(out.chart.replace(/```chart\n|\n```/g, "")).type).toBe("bar");
  });

  test("mismatched lengths are refused", async () => {
    expect(typeof (await run("render_chart", { type: "bar", labels: ["a"], values: [1, 2] })).error).toBe("string");
  });

  test("a non-numeric value is refused", async () => {
    expect(typeof (await run("render_chart", { type: "bar", labels: ["a"], values: ["x"] })).error).toBe("string");
  });
});

describe("diff_text", () => {
  test("marks changed lines and leaves unchanged ones alone", async () => {
    const out = await run("diff_text", { before: "a\nb\nc", after: "a\nB\nc" });
    expect(out.diff).toContain("-b");
    expect(out.diff).toContain("+B");
    expect(out.diff).toContain(" a");
  });

  test("identical inputs produce no change markers", async () => {
    const out = await run("diff_text", { before: "x\ny", after: "x\ny" });
    expect(out.diff).not.toContain("-x");
    expect(out.diff).not.toContain("+x");
  });

  test("a long unchanged run is collapsed, not printed in full", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    // Changes on BOTH sides, so the unchanged run sits between them and must be
    // elided rather than printed in full. (A trailing run is dropped entirely,
    // which is the documented behaviour and a separate case.)
    const out = await run("diff_text", { before: `top\n${long}\nbottom`, after: `TOP\n${long}\nBOTTOM` });
    expect(out.diff).toContain("unchanged lines");
    expect(out.diff).toContain("+TOP");
    expect(out.diff).toContain("+BOTTOM");
    expect(out.diff).not.toContain("line20");
  });
});

describe("csv_query and file_read", () => {
  test("parseCsv keeps a quoted comma inside one field", async () => {
    const { headers, rows } = parseCsv('name,note\n"Smith, John",ok\n');
    expect(headers).toEqual(["name", "note"]);
    expect(rows[0]).toEqual(["Smith, John", "ok"]);
  });

  test("lists columns and rows", async () => {
    const csv = textAttachment("data.csv", "text/csv", "name,qty\nA,2\nB,3\n");
    const columns = (await run("csv_query", { operation: "columns" }, [csv]));
    expect(columns.columns).toEqual(["name", "qty"]);
    expect(columns.rows).toBe(2);
    const rows = (await run("csv_query", { operation: "rows", limit: 1 }, [csv]));
    expect(rows.rows[0]).toEqual({ name: "A", qty: "2" });
  });

  test("aggregates a numeric column", async () => {
    const csv = textAttachment("data.csv", "text/csv", "name,qty\nA,2\nB,3\nC,10\n");
    expect(((await run("csv_query", { operation: "aggregate", column: "qty", agg: "sum" }, [csv]))).value).toBe(15);
    expect(((await run("csv_query", { operation: "aggregate", column: "qty", agg: "avg" }, [csv]))).value).toBe(5);
    expect(((await run("csv_query", { operation: "aggregate", column: "qty", agg: "max" }, [csv]))).value).toBe(10);
  });

  test("an unknown column is refused and the real ones are listed", async () => {
    const csv = textAttachment("data.csv", "text/csv", "name,qty\nA,2\n");
    const out = (await run("csv_query", { operation: "aggregate", column: "price" }, [csv]));
    expect(typeof out.error).toBe("string");
    expect(out.columns).toEqual(["name", "qty"]);
  });

  test("reads a text attachment", async () => {
    const file = textAttachment("notes.md", "text/markdown", "# Title\n\nbody");
    const out = (await run("file_read", {}, [file]));
    expect(out.content).toContain("# Title");
    expect(out.file).toBe("notes.md");
  });

  test("refuses a binary attachment instead of dumping it", async () => {
    const img = { kind: "image" as const, name: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const out = (await run("file_read", {}, [img]));
    expect(typeof out.error).toBe("string");
  });

  test("no attachment at all is an error naming what was attached", async () => {
    const out = (await run("file_read", {}, []));
    expect(out.error).toContain("none");
  });
});
