/**
 * Per-provider circuit breaker.
 *
 * The breaker exists because account health deliberately does *not* remember a
 * provider-wide outage: `classifyAccountError` returns `mutatesAccount: false`
 * for a 5xx so one dead provider cannot disable all 191 of its accounts. That
 * decision is correct, but it left nothing recording the outage, so every later
 * request re-dialed the dead provider and paid a connection timeout before
 * failing over. These tests pin the properties that make the replacement safe:
 *
 * - **It trips only after repeated failures.** One blip must not deprioritize a
 *   provider: that would trade a rare timeout for a systematic slowdown.
 * - **It closes on the first success.** Recovery must not depend on an
 *   arbitrary number of further successes, or a provider that just came back
 *   stays deprioritized for no reason.
 * - **Failures outside the window do not accumulate.** A provider that fails
 *   once every few minutes is flaky, not down; counting those to a trip would
 *   eventually deprioritize every provider.
 * - **The window expires on its own.** An open circuit must not be permanent —
 *   there is no operator action to clear it, so it has to heal by time.
 * - **Provider ids are case-insensitive.** Upstream casing is not stable, and a
 *   `Grok` failure that did not match a `grok` lookup would silently never trip.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  configureProviderCircuitForTesting,
  isProviderCircuitOpen,
  providerCircuitSnapshot,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderCircuitsForTesting,
} from "../../src/transport/routing/provider-circuit";

beforeEach(() => {
  resetProviderCircuitsForTesting();
  configureProviderCircuitForTesting({ threshold: 3, openDurationMs: 60_000 });
});

describe("provider circuit breaker", () => {
  test("stays closed below the threshold", () => {
    const now = 1_000_000;
    expect(recordProviderFailure("grok", now)).toBe(false);
    expect(recordProviderFailure("grok", now + 1)).toBe(false);
    expect(isProviderCircuitOpen("grok", now + 2)).toBe(false);
  });

  test("trips at the threshold and reports open", () => {
    const now = 1_000_000;
    recordProviderFailure("grok", now);
    recordProviderFailure("grok", now + 1);
    expect(recordProviderFailure("grok", now + 2)).toBe(true);
    expect(isProviderCircuitOpen("grok", now + 3)).toBe(true);
  });

  test("a success closes the circuit immediately", () => {
    const now = 1_000_000;
    recordProviderFailure("grok", now);
    recordProviderFailure("grok", now + 1);
    recordProviderFailure("grok", now + 2);
    expect(isProviderCircuitOpen("grok", now + 3)).toBe(true);
    recordProviderSuccess("grok");
    expect(isProviderCircuitOpen("grok", now + 4)).toBe(false);
  });

  test("the open window expires without operator action", () => {
    const now = 1_000_000;
    recordProviderFailure("grok", now);
    recordProviderFailure("grok", now + 1);
    recordProviderFailure("grok", now + 2);
    expect(isProviderCircuitOpen("grok", now + 3)).toBe(true);
    // Past the 60s window the provider must be probed again: there is no manual
    // reset, so a permanent circuit would take the provider out forever. The
    // window opens at the tripping failure (`now + 2`), so it expires 60s later.
    expect(isProviderCircuitOpen("grok", now + 60_003)).toBe(false);
  });

  test("failures outside the window do not accumulate", () => {
    // One failure every 3 minutes is a flaky provider, not a dead one. If these
    // accumulated, every provider would eventually trip.
    let now = 1_000_000;
    expect(recordProviderFailure("flaky", now)).toBe(false);
    now += 200_000; // beyond the 120s window
    expect(recordProviderFailure("flaky", now)).toBe(false);
    now += 200_000;
    expect(recordProviderFailure("flaky", now)).toBe(false);
    expect(isProviderCircuitOpen("flaky", now)).toBe(false);
  });

  test("providers are tracked independently", () => {
    const now = 1_000_000;
    recordProviderFailure("grok", now);
    recordProviderFailure("grok", now + 1);
    recordProviderFailure("grok", now + 2);
    expect(isProviderCircuitOpen("grok", now + 3)).toBe(true);
    // A sibling provider must be unaffected by grok's outage.
    expect(isProviderCircuitOpen("dahl", now + 3)).toBe(false);
  });

  test("provider ids are matched case-insensitively", () => {
    const now = 1_000_000;
    recordProviderFailure("Grok", now);
    recordProviderFailure("GROK", now + 1);
    recordProviderFailure("grok", now + 2);
    // Upstream casing is not stable; a mismatch here would mean the breaker
    // silently never trips for that provider.
    expect(isProviderCircuitOpen("grok", now + 3)).toBe(true);
    recordProviderSuccess("GrOk");
    expect(isProviderCircuitOpen("grok", now + 4)).toBe(false);
  });

  test("snapshot reports open state for diagnostics", () => {
    const now = 1_000_000;
    recordProviderFailure("grok", now);
    recordProviderFailure("grok", now + 1);
    recordProviderFailure("grok", now + 2);
    const snap = providerCircuitSnapshot(now + 3);
    const grok = snap.find((entry) => entry.providerId === "grok");
    expect(grok?.open).toBe(true);
    expect(typeof grok?.openUntil).toBe("number");
  });

  test("an unknown provider is never open", () => {
    expect(isProviderCircuitOpen("never-seen", 1_000_000)).toBe(false);
  });
});
