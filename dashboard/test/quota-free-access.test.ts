/**
 * Free-tier badge derivation.
 *
 * The badge answers one operator question — "how long is this still free?" —
 * and the whole reason it needs a test is that the upstream reports a free tier
 * as *two* kinds of window that mean opposite things:
 *
 * - A **recurring** window ("Monthly", `recurring: true`) refills. Its
 *   `resetsAt` is not an end date, so rendering it as "free until <date>" would
 *   tell the operator access stops on a date it actually continues past.
 * - A **non-recurring** window ("Bonus Pack", `recurring: false`) is a grant
 *   with a real deadline. That date is a genuine end date.
 *
 * So the properties pinned here are: a hard expiry wins over a reset, a reset
 * is still reported (as `recurring`) when it is all there is, a spent window is
 * never used as the answer, and a paid plan produces no badge at all.
 */
import { describe, expect, test } from "bun:test";
import { freeAccessBadge, freeAccessFromQuota } from "../src/shared/quota-formatters";

/** A window shaped like the live CodeBuddy/WorkBuddy payloads. */
function window(overrides: Partial<{
  kind: string;
  label: string;
  remainingPercent: number | null;
  resetsAt: string | null;
  recurring: boolean;
  remaining: number | null;
}> = {}) {
  return {
    kind: overrides.kind ?? "quota:monthly",
    label: overrides.label ?? "Monthly",
    remainingPercent: overrides.remainingPercent ?? 100,
    resetsAt: overrides.resetsAt ?? "2026-10-31T23:59:59.000Z",
    recurring: overrides.recurring ?? true,
    remaining: overrides.remaining ?? null,
  };
}

describe("freeAccessFromQuota", () => {
  test("returns null for a paid plan, so no misleading Free badge", () => {
    expect(freeAccessFromQuota({ plan: "Pro Plan", windows: [window()] })).toBeNull();
    expect(freeAccessFromQuota({ plan: null, windows: [window()] })).toBeNull();
    expect(freeAccessFromQuota(null)).toBeNull();
    expect(freeAccessFromQuota(undefined)).toBeNull();
  });

  test("recognises the live free plan name", () => {
    // The exact string the CodeBuddy/WorkBuddy billing endpoint returns.
    const out = freeAccessFromQuota({ plan: "Free Plan Subscription", windows: [window()] });
    expect(out?.plan).toBe("Free Plan Subscription");
  });

  test("a hard expiry outranks a recurring reset", () => {
    // A monthly allowance (recurring, resets 31 Oct) plus a bonus pack that
    // really expires 12 Nov. "Free until" must name the expiry, not the reset.
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [
        window({ kind: "quota:monthly", resetsAt: "2026-10-31T23:59:59.000Z", recurring: true }),
        window({ kind: "bonus:1", label: "Bonus Pack 1", resetsAt: "2026-11-12T02:05:06.000Z", recurring: false }),
      ],
    });
    expect(out?.until).toBe("2026-11-12T02:05:06.000Z");
    expect(out?.recurring).toBe(false);
  });

  test("picks the farthest expiry when several grants exist", () => {
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [
        window({ kind: "bonus:1", resetsAt: "2026-10-25T04:15:31.000Z", recurring: false }),
        window({ kind: "bonus:2", resetsAt: "2027-03-24T22:37:45.000Z", recurring: false }),
        window({ kind: "bonus:3", resetsAt: "2026-11-06T03:25:43.000Z", recurring: false }),
      ],
    });
    expect(out?.until).toBe("2027-03-24T22:37:45.000Z");
  });

  test("falls back to a recurring window, flagged as recurring", () => {
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [window({ resetsAt: "2026-10-31T23:59:59.000Z", recurring: true })],
    });
    expect(out?.until).toBe("2026-10-31T23:59:59.000Z");
    // The flag is what lets the UI say "resets" instead of "until".
    expect(out?.recurring).toBe(true);
  });

  test("a spent window is not offered as the answer", () => {
    // A date on an exhausted grant is not a date the operator can still use.
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [
        window({ kind: "bonus:1", resetsAt: "2026-11-12T02:05:06.000Z", recurring: false, remainingPercent: 0 }),
        window({ kind: "bonus:2", resetsAt: "2026-12-01T00:00:00.000Z", recurring: false, remainingPercent: 40 }),
      ],
    });
    expect(out?.until).toBe("2026-12-01T00:00:00.000Z");
  });

  test("every window spent reports exhausted rather than a date", () => {
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [
        window({ remainingPercent: 0 }),
        window({ kind: "bonus:1", remainingPercent: 0, recurring: false }),
      ],
    });
    expect(out?.exhausted).toBe(true);
    expect(out?.until).toBeNull();
    expect(freeAccessBadge(out)).toBe("Free quota used");
  });

  test("an absolute remaining value also counts as usable", () => {
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [window({ remainingPercent: null, remaining: 30 })],
    });
    expect(out?.exhausted).toBe(false);
  });

  test("reports the best remaining percentage", () => {
    const out = freeAccessFromQuota({
      plan: "Free Plan Subscription",
      windows: [window({ remainingPercent: 20 }), window({ remainingPercent: 80 })],
    });
    expect(out?.remainingPercent).toBe(80);
  });

  test("a free plan with no windows still badges", () => {
    const out = freeAccessFromQuota({ plan: "Free Plan Subscription", windows: [] });
    expect(out?.exhausted).toBe(false);
    expect(freeAccessBadge(out)).toBe("Free plan");
  });
});

describe("freeAccessBadge", () => {
  test("says 'until' for a real expiry and 'resets' for a recurring one", () => {
    const expiry = freeAccessBadge(
      freeAccessFromQuota({
        plan: "Free Plan Subscription",
        windows: [window({ resetsAt: "2026-11-12T02:05:06.000Z", recurring: false })],
      }),
    );
    const reset = freeAccessBadge(
      freeAccessFromQuota({
        plan: "Free Plan Subscription",
        windows: [window({ resetsAt: "2026-10-31T23:59:59.000Z", recurring: true })],
      }),
    );
    expect(expiry).toContain("Free until");
    expect(reset).toContain("resets");
    // The distinction matters: "until" implies access ends, "resets" implies it
    // continues. Confusing them misinforms the operator about the same date.
    expect(reset).not.toContain("Free until");
  });

  test("null access renders nothing", () => {
    expect(freeAccessBadge(null)).toBeNull();
  });
});
