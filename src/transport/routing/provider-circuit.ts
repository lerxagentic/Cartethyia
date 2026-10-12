/**
 * Per-provider circuit breaker.
 *
 * ## The gap this closes
 *
 * Account health already handles *account-scoped* failures: a 429 or a quota
 * refusal cools that one credential down and routing tries a sibling. But a
 * provider-wide outage is a different shape, and it deliberately does **not**
 * mutate accounts — `classifyAccountError` returns `mutatesAccount: false` for
 * a 5xx, because cooling one account per failed request would, on a provider
 * with 191 keys, disable all 191 while the upstream was merely restarting.
 *
 * The cost of that correct decision was that nothing remembered the outage at
 * all. Every subsequent request re-dialed the same dead provider, paying a full
 * connection timeout each time before failing over. With one provider down out
 * of nine, that is a latency tax on every request that happened to pick it.
 *
 * This breaker supplies the missing memory. It is keyed by provider, not
 * account, so a provider-wide fault is recorded once and consulted once.
 *
 * ## Why in-process, and why deprioritized rather than excluded
 *
 * **In-process** matches how the pool selector keeps its own volatile cooldown
 * state, and it is the honest scope for a breaker: the state is an optimisation
 * for *this* instance's next request, not a durable fact worth a migration. A
 * restart clearing it is correct — the first request after a restart re-probes,
 * which is exactly what a half-open circuit should do anyway.
 *
 * **Deprioritized, not excluded**, for the same reason the account evaluator
 * deprioritizes a cooling account: a single-provider deployment must still
 * serve traffic when that provider is the only one configured. Excluding would
 * turn a slow provider into a total outage. Ordering carries the intent — a
 * tripped provider is tried only after every healthy one.
 *
 * ## Failure counting
 *
 * Only `scope: "provider"` failures count. A network-origin error is the local
 * egress, not the provider, and an account-scoped error is already handled by
 * the account machinery; counting either here would trip the breaker on a
 * problem the provider does not have.
 *
 * A success closes the circuit immediately. This is deliberate: the breaker's
 * job is to stop hammering a dead provider, and the first request that gets a
 * real answer is proof the provider is back. Keeping the count would make
 * recovery depend on an arbitrary number of extra successes.
 */

/** Provider ids are compared case-insensitively; upstream casing is not stable. */
function key(providerId: string): string {
  return providerId.trim().toLowerCase();
}

interface CircuitState {
  /** Consecutive provider-scoped failures since the last success. */
  failures: number;
  /** Epoch ms until which the circuit is open. `0` means closed. */
  openUntil: number;
}

/** Failures within the window needed to trip. */
const FAILURE_THRESHOLD = 3;
/** How long a tripped provider stays deprioritized before it is probed again. */
const OPEN_DURATION_MS = 60_000;
/** A failure older than this no longer counts toward the threshold, so a
 *  provider that fails once an hour is never mistaken for one that is down. */
const FAILURE_WINDOW_MS = 120_000;
/** Bound on tracked providers: a runaway id must not grow the map forever. */
const MAX_TRACKED = 1_000;

interface Entry {
  state: CircuitState;
  lastFailureAt: number;
}

const circuits = new Map<string, Entry>();

/** Test-only: clears all breaker state. */
export function resetProviderCircuitsForTesting(): void {
  circuits.clear();
}

/** Test-only: overrides the thresholds for a deterministic test. */
let thresholdOverride: number | undefined;
let openDurationOverride: number | undefined;
export function configureProviderCircuitForTesting(options: {
  threshold?: number;
  openDurationMs?: number;
}): void {
  thresholdOverride = options.threshold;
  openDurationOverride = options.openDurationMs;
}

function threshold(): number {
  return thresholdOverride ?? FAILURE_THRESHOLD;
}

function openDurationMs(): number {
  return openDurationOverride ?? OPEN_DURATION_MS;
}

/**
 * Records a provider-scoped failure. Returns true when this failure tripped the
 * circuit, so a caller can log the transition exactly once.
 */
export function recordProviderFailure(providerId: string, now = Date.now()): boolean {
  const k = key(providerId);
  const entry = circuits.get(k) ?? { state: { failures: 0, openUntil: 0 }, lastFailureAt: 0 };
  // A failure outside the window means the previous streak is stale: a provider
  // that fails once every few minutes is flaky, not down, and must not
  // accumulate its way to a trip.
  const withinWindow = now - entry.lastFailureAt <= FAILURE_WINDOW_MS;
  entry.state.failures = withinWindow ? entry.state.failures + 1 : 1;
  entry.lastFailureAt = now;
  let tripped = false;
  if (entry.state.failures >= threshold()) {
    entry.state.openUntil = now + openDurationMs();
    entry.state.failures = 0;
    tripped = true;
  }
  circuits.set(k, entry);
  if (circuits.size > MAX_TRACKED) prune(now);
  return tripped;
}

/** Records a success, closing the circuit immediately. */
export function recordProviderSuccess(providerId: string): void {
  circuits.delete(key(providerId));
}

/** Whether the provider is currently deprioritized. */
export function isProviderCircuitOpen(providerId: string, now = Date.now()): boolean {
  const entry = circuits.get(key(providerId));
  if (!entry) return false;
  if (entry.state.openUntil > now) return true;
  // The open window elapsed: leave the (now closed) entry in place so the next
  // failure starts a fresh streak, but report it healthy so it is probed.
  return false;
}

/** Drops entries whose window has long passed, keeping the map bounded. */
function prune(now: number): void {
  for (const [k, entry] of circuits) {
    const idle = entry.state.openUntil < now && now - entry.lastFailureAt > FAILURE_WINDOW_MS;
    if (idle) circuits.delete(k);
    if (circuits.size <= MAX_TRACKED / 2) break;
  }
}

/** Snapshot for diagnostics and the console. */
export function providerCircuitSnapshot(
  now = Date.now(),
): Array<{ providerId: string; failures: number; openUntil: number | null; open: boolean }> {
  return [...circuits.entries()].map(([providerId, entry]) => ({
    providerId,
    failures: entry.state.failures,
    openUntil: entry.state.openUntil > now ? entry.state.openUntil : null,
    open: entry.state.openUntil > now,
  }));
}
