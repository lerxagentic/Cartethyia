/**
 * Audits the model catalog against what every provider with an account
 * actually advertises. Uses the real ProviderRegistry discovery path
 * (resolveModelDiscovery) with refresh-aware credential resolution so the
 * comparison is against live upstream catalogs, not the seed lists.
 *
 *   bun scripts/audit-models.ts [providerId ...]
 */
import { createDefaultProviderRegistry } from "../src/providers/default-registry";
import { getDb } from "../src/persistence/postgres";
import { providerAccounts, models, providers } from "../src/persistence/schema";
import { eq } from "drizzle-orm";
import { providerBaseUrl } from "../src/providers/provider-metadata";
import { createAccountSecretResolver } from "../src/providers/operations/provider-credential-service";
import { OAuthRefreshService } from "../src/providers/authentication/oauth-refresh-service";

const db = getDb();
const registry = createDefaultProviderRegistry();
const onlyProviders = process.argv.slice(2);

// Accounts grouped by provider
const accountRows = await db.select({
  id: providerAccounts.id,
  providerId: providerAccounts.providerId,
  label: providerAccounts.label,
  tenantId: providerAccounts.tenantId,
  authState: providerAccounts.authState,
}).from(providerAccounts);

// Models currently registered (for tenant-scoped rows, treat across all tenants)
const modelRows = await db.select({ providerId: models.providerId, modelId: models.modelId }).from(models);
const dbModelByProvider = new Map<string, Set<string>>();
for (const m of modelRows) {
  const s = dbModelByProvider.get(m.providerId) ?? new Set<string>();
  s.add(m.modelId);
  dbModelByProvider.set(m.providerId, s);
}

// Provider rows (BYOK etc)
const providerRows = await db.select({ id: providers.id, tenantId: providers.tenantId }).from(providers);
const providerTenantMap = new Map<string, string | null>();
for (const p of providerRows) providerTenantMap.set(p.id, p.tenantId);
const byProviderAccounts = new Map<string, typeof accountRows>();
for (const a of accountRows) {
  const arr = byProviderAccounts.get(a.providerId) ?? [];
  arr.push(a);
  byProviderAccounts.set(a.providerId, arr);
}

const providersToCheck = [...byProviderAccounts.keys()].filter(
  (p) => onlyProviders.length === 0 || onlyProviders.includes(p),
);

for (const providerId of providersToCheck) {
  const discovery = await registry.resolveModelDiscovery(providerId);
  const accounts = byProviderAccounts.get(providerId) ?? [];
  const account = accounts[0];
  console.log(`\n========== ${providerId} (${accounts.length} accounts) ==========`);

  if (!discovery) {
    console.log("  no model discovery capability — catalog is seed/static only");
    continue;
  }

  // Resolve a fresh credential for one account (prefer non-null tenant)
  let credential = "";
  // Non-secret per-account auth config (authState lives on the account row;
  // the secret resolver only returns the secret string).
  let authState: Record<string, unknown> | undefined;
  let baseUrl = providerTenantMap.has(providerId)
    ? (await db.select({ b: providers.baseUrl }).from(providers).where(eq(providers.id, providerId))).at(0)?.b ?? providerBaseUrl(providerId)
    : providerBaseUrl(providerId);
  const oauthRefreshService = new OAuthRefreshService(db);
  const secretResolver = createAccountSecretResolver({
    db,
    resolveRefresher: (p) => registry.resolveRefresher(p),
    refreshService: oauthRefreshService,
  });
  if (account) {
    authState = (account as { authState?: unknown }).authState as Record<string, unknown> | undefined;
    try {
      credential = await secretResolver(providerId, account.id);
      const row = await db.select({ b: providers.baseUrl }).from(providers).where(eq(providers.id, providerId));
      baseUrl = row.at(0)?.b ?? baseUrl;
    } catch (e) {
      console.log(`  credential resolve failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }
  const baseUrlClean = (baseUrl ?? "").replace(/\/+$/, "");

  let upstream: readonly { modelId?: string; model?: string; id?: string }[] | null = null;
  try {
    const found = await discovery({ baseUrl: baseUrlClean, credential, ...(authState ? { authState } : {}) });
    upstream = found as unknown as readonly { modelId?: string; model?: string; id?: string }[] | null;
  } catch (e) {
    console.log(`  discovery fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const dbSet = dbModelByProvider.get(providerId) ?? new Set<string>();
  if (!upstream || upstream.length === 0) {
    console.log(`  upstream advertised 0 models (credential: ${credential ? "present" : "none"}).`);
    console.log(`  db models (${dbSet.size}): ${[...dbSet].join(", ")}`);
    continue;
  }

  const upSet = new Set(upstream.map((m) => m.modelId ?? m.model ?? m.id ?? "").filter((x) => x.length > 0));
  const missing = [...upSet].filter((m) => !dbSet.has(m)).sort();
  const extra = [...dbSet].filter((m) => !upSet.has(m)).sort();
  console.log(`  upstream models (${upSet.size}): ${[...upSet].join(", ")}`);
  if (missing.length) console.log(`  >> MISSING from db (${missing.length}): ${missing.join(", ")}`);
  if (extra.length) console.log(`  >> in db but NOT upstream (${extra.length}): ${extra.join(", ")}`);
  if (missing.length === 0 && extra.length === 0) console.log("  catalog matches upstream exactly");
}
process.exit(0);
