/**
 * Syncs every provider's model catalog against its live upstream discovery,
 * using the same `ProviderProbingService.syncModels` path the console's
 * "Fetch models" button uses. Read-only for credentials; writes only the
 * `models` table (upsert) and invalidates the route snapshot.
 *
 *   bun scripts/sync-models.ts [providerId ...]
 */
import { getDb } from "../src/persistence/postgres";
import { providerAccounts, providers, models } from "../src/persistence/schema";
import { eq } from "drizzle-orm";
import { createDefaultProviderRegistry } from "../src/providers/default-registry";
import { createProviderProbingServiceForTests } from "../src/providers/discovery/probing-service";
import { OAuthRefreshService } from "../src/providers/authentication/oauth-refresh-service";
import { createAccountSecretResolver } from "../src/providers/operations/provider-credential-service";

const db = getDb();
const registry = createDefaultProviderRegistry();
const onlyProviders = process.argv.slice(2);

const accountRows = await db
  .select({ id: providerAccounts.id, providerId: providerAccounts.providerId, status: providerAccounts.status, tenantId: providerAccounts.tenantId })
  .from(providerAccounts);
const modelRows = await db.select({ p: models.providerId, m: models.modelId }).from(models);
const before = new Map<string, Set<string>>();
for (const r of modelRows) {
  const s = before.get(r.p) ?? new Set<string>();
  s.add(r.m);
  before.set(r.p, s);
}

const secretResolver = createAccountSecretResolver({
  db,
  resolveRefresher: (p) => registry.resolveRefresher(p),
  refreshService: new OAuthRefreshService(db),
});

const probing = createProviderProbingServiceForTests({
  db,
  providerRegistry: registry,
  outboundFetchFor: () => ({ fetch }) as never,
  snapshotInvalidator: { invalidate: () => 0 },
});

const accountsByProvider = new Map<string, typeof accountRows>();
for (const a of accountRows) {
  const arr = accountsByProvider.get(a.providerId) ?? [];
  arr.push(a);
  accountsByProvider.set(a.providerId, arr);
}

const targets = [...accountsByProvider.keys()].filter(
  (p) => onlyProviders.length === 0 || onlyProviders.includes(p),
);

for (const providerId of targets) {
  // The tenant that owns the provider row (global/bundled providers use the
  // tenant lattice; syncModels needs a concrete tenant for outbound binding
  // and account scoping).
  let tenantId: string | null = null;
  const providersOf = await db.select({ t: providers.tenantId }).from(providers).where(eq(providers.id, providerId));
  if (providersOf[0]?.t) {
    tenantId = providersOf[0].t;
  } else {
    const acct = accountsByProvider.get(providerId)?.[0];
    if (acct && acct.tenantId) tenantId = acct.tenantId;
  }
  const firstAccount = accountsByProvider.get(providerId)?.[0];
  if (firstAccount) {
    try {
      await secretResolver(providerId, firstAccount.id);
    } catch (e) {
      console.log(`${providerId}: credential resolve failed — ${e instanceof Error ? e.message : e}`);
      continue;
    }
  }
  try {
    if (tenantId === null) throw new Error("no tenant scope resolved");
    const result = await probing.syncModels(tenantId, providerId);
    const after = new Set(
      (await db.select({ m: models.modelId }).from(models).where(eq(models.providerId, providerId))).map((r) => r.m),
    );
    const prev = before.get(providerId) ?? new Set();
    const added = [...after].filter((m) => !prev.has(m));
    const removed = [...prev].filter((m) => !after.has(m));
    console.log(
      `${providerId}: synced=${result.synced}` +
        (added.length ? ` | ADDED: ${added.join(", ")}` : "") +
        (removed.length ? ` | REMOVED: ${removed.join(", ")}` : ""),
    );
  } catch (e) {
    console.log(`${providerId}: sync failed — ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(0);
