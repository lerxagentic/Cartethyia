/**
 * A throttle's hard, model-scoped exclusion must rest on a *stated* reset.
 *
 * `model_cooldown` is a hard exclusion: the catalog projects an unexpired
 * per-model entry as `health_status: "model_cooldown"`, and the evaluator drops
 * that (account, model) pair from the plan entirely. Writing one from the
 * classifier's own fallback therefore declares the pair exhausted on a guess.
 *
 * The failure this guards: Google Antigravity answers a bare 429 "Resource has
 * been exhausted (e.g. check quota)." with no reset window. The classifier
 * stamped a 15-minute model-scoped cooldown on `gemini-3.8-flash`, and because
 * every account served only that model, all of them were dropped at once — the
 * gateway answered 503 `accounts_unavailable` for a quarter hour while the
 * account's real quota still read 89% remaining. The upstream never said the
 * pair was exhausted, so the pair must not be treated as if it had.
 *
 * The fix has two halves, both asserted here:
 *  - `deadlineStated` distinguishes the upstream's own window from the
 *    fallback, and `persistAccountFailure` only takes the model-scoped path
 *    when it is true;
 *  - an unstated, non-IP-scoped 429 backs off for the short transient window,
 *    so a momentary throttle is a blip rather than a quarter-hour outage.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

/** The evidence the dispatch path builds for an upstream, account-scoped 429. */
function throttle(message: string, providerId: string) {
  return classifyAccountError(new Error(message), {
    statusCode: 429,
    origin: "upstream",
    scope: "account",
    credentialEvidence: true,
    modelId: "gemini-3.8-flash",
    providerId,
  });
}

describe("a 429 with no stated reset", () => {
  test("is not a stated deadline", () => {
    // The real Antigravity message: a bare throttle, no window named.
    const c = throttle("Resource has been exhausted (e.g. check quota).", "antigravity");
    expect(c.category).toBe("rate_limit_transient");
    expect(c.deadlineStated).toBe(false);
  });

  test("backs off for the short transient window, not the long rate-limit fallback", () => {
    const c = throttle("Resource has been exhausted (e.g. check quota).", "antigravity");
    // The long fallback (15 min) turned a blip into a quarter-hour outage once
    // every account serving the model had been cooled.
    expect(c.cooldownMs).toBe(30_000);
    expect(c.cooldownMs).toBeLessThan(15 * 60 * 1000);
  });

  test("still mutates the account so routing fails over to a sibling", () => {
    const c = throttle("Resource has been exhausted (e.g. check quota).", "antigravity");
    expect(c.mutatesAccount).toBe(true);
  });
});

describe("a 429 that states its own reset window", () => {
  test("is a stated deadline", () => {
    const c = throttle("Daily free limit reached. Try again in 11h.", "codebuddy");
    expect(c.deadlineStated).toBe(true);
  });

  test("keeps the provider's own duration", () => {
    const c = throttle("Daily free limit reached. Try again in 11h.", "codebuddy");
    expect(c.cooldownMs).toBe(11 * 60 * 60 * 1000);
  });
});

describe("an IP-scoped provider", () => {
  test("keeps the long fallback for an unstated 429, because the address is the fix", () => {
    // A credential-less free tier answers 429 for the request's own address, so
    // retrying from it reproduces the refusal no matter which account is
    // selected — backing the address off IS the remedy, so the long fallback is
    // correct here even without a stated window.
    const c = throttle("Too many requests.", "opencodeft");
    expect(c.deadlineStated).toBe(false);
    expect(c.cooldownMs).toBe(15 * 60 * 1000);
  });
});
