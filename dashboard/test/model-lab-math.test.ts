/**
 * Math detection in the Model Lab transcript.
 *
 * `MATH_PATTERN` decides whether a message needs the KaTeX stylesheet. It is a
 * gate, so both directions matter:
 *
 * - A **false positive** pulls 23 kB of CSS and re-parses a message that had no
 *   math, for nothing.
 * - A **false negative** shows `$10^5$` as literal text, which is the bug this
 *   whole change exists to fix.
 *
 * The dangerous case is a message about money: `harga $10 dan $20` contains two
 * dollar signs but is not math, and a naive `/\$.*\$/` would match it. remark-math
 * requires a non-space immediately after the opening `$`, so the pattern must too.
 */
import { describe, expect, test } from "bun:test";

/** Kept in sync with `MATH_PATTERN` in components/studio/markdown.tsx. A drift
 *  here means the gate and the renderer disagree, which is exactly the failure
 *  this suite is meant to catch. */
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?(?<!\s)\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/;

const hasMath = (text: string) => MATH_PATTERN.test(text);

describe("math detection", () => {
  test("detects the formula that motivated this change", () => {
    // The exact text from the screenshot.
    expect(hasMath("1 km = 100.000 cm (dikalikan $10^5$)")).toBe(true);
  });

  test("detects inline, display, and bracket forms", () => {
    expect(hasMath("the value is $x^2 + y^2$ here")).toBe(true);
    expect(hasMath("$$\n\\int_0^1 x\\,dx\n$$")).toBe(true);
    expect(hasMath("inline \\(a+b\\) math")).toBe(true);
    expect(hasMath("display \\[a+b\\] math")).toBe(true);
  });

  test("does NOT fire on prices — the false-positive that costs the most", () => {
    expect(hasMath("harga $10 dan $20")).toBe(false);
    expect(hasMath("it costs $5")).toBe(false);
    expect(hasMath("$ 10")).toBe(false);
  });

  test("does NOT fire on ordinary prose", () => {
    expect(hasMath("jelaskan TCP")).toBe(false);
    expect(hasMath("")).toBe(false);
    expect(hasMath("write a haiku about rain")).toBe(false);
  });

  test("does not span a newline for inline math", () => {
    // An unclosed `$` on one line must not swallow the next one.
    expect(hasMath("price is $5\nand $6")).toBe(false);
  });

  test("a lone trailing dollar is not math", () => {
    expect(hasMath("total $")).toBe(false);
  });
});
