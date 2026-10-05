/**
 * Converts Cartethyia's own backup payload into a 9Router export, so the
 * Download action can emit a file the 9Router console's "Import Database"
 * (`importDb`) accepts as-is.
 *
 * This is a lossy, best-effort projection — Cartethyia carries data the
 * router has no home for (tenants, telemetry, route snapshots), and the
 * router carries settings this side never stores. Sections we cannot express
 * are *omitted entirely* rather than sent empty: `importDb` only wipes the
 * sections present in the payload, so an absent section leaves the receiving
 * router's data untouched instead of blanking it. In particular `apiKeys` is
 * never exported — only the hash is persisted here, and the router restores
 * keys by their plaintext `key`, which we cannot reconstruct.
 *
 * Credential rows are decrypted at export time (same threat model as the
 * native export: the file is as sensitive as the database).
 */
import { decryptCredentialToString } from "../../security/crypto";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts, providerOauthStates, modelCombos, modelAliases, models } from "../../persistence/schema";
import { and, eq, inArray, ne } from "drizzle-orm";

/** Cartethyia provider id → 9Router provider id (inverse of the import map). */
const TO_ROUTER_PROVIDER: Readonly<Record<string, string>> = {
  grok: "grok-cli",
  xai: "xai",
  cb: "codebuddy-intl",
  cbcn: "codebuddy-cn",
  opencodeft: "opencode",
  opencodego: "opencode-go",
  opencodezen: "opencode-zen",
  gemini: "gemini-cli",
  kiro: "kiro",
  antigravity: "antigravity",
  codex: "codex",
  dahl: "dahl",
  claude: "claude",
  kimi: "kimi",
  cline: "cline",
};

/** Cartethyia provider id → the router's `customModels.providerAlias` spelling. */
const TO_ROUTER_ALIAS: Readonly<Record<string, string>> = {
  grok: "gcli",
  cb: "cbai",
  opencodeft: "oc",
  dahl: "dahl",
};

export interface NineRouterExportReport {
  readonly payload: Record<string, unknown>;
  readonly counts: Record<string, number>;
  readonly omitted: readonly string[];
}

const ROUTER_ONLY_SECTIONS = ["settings", "proxyPools", "usageHistory", "usageDaily", "pricing", "mitmAlias", "modelOverrides"] as const;

export async function convertToNineRouterExport(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<NineRouterExportReport> {
  const now = new Date().toISOString();
  const omitted: string[] = [...ROUTER_ONLY_SECTIONS, "apiKeys"];

  const accounts = await db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      label: providerAccounts.label,
      credentialCiphertext: providerAccounts.credentialCiphertext,
      credentialKind: providerAccounts.credentialKind,
      authState: providerAccounts.authState,
      status: providerAccounts.status,
      sortIndex: providerAccounts.sortIndex,
      createdAt: providerAccounts.createdAt,
      refreshToken: providerOauthStates.refreshCiphertext,
      expiresAt: providerOauthStates.expiresAt,
    })
    .from(providerAccounts)
    .leftJoin(providerOauthStates, eq(providerOauthStates.providerAccountId, providerAccounts.id))
    .where(and(eq(providerAccounts.tenantId, tenantId), ne(providerAccounts.status, "disabled")));

  const providerConnections: Record<string, unknown>[] = [];
  const unmappedProviders = new Set<string>();
  for (const row of accounts) {
    const routerProvider = TO_ROUTER_PROVIDER[row.providerId];
    if (routerProvider === undefined) {
      unmappedProviders.add(row.providerId);
      continue;
    }
    if (row.credentialCiphertext === null) continue;
    const credential = decryptCredentialToString(row.credentialCiphertext);
    const isOauth = row.credentialKind === "oauth";
    const authState = (row.authState ?? {}) as Record<string, unknown>;
    providerConnections.push({
      id: row.id,
      provider: routerProvider,
      authType: isOauth ? "oauth" : "apikey",
      name: row.label,
      email: typeof authState.email === "string" ? authState.email : null,
      priority: row.sortIndex ?? 0,
      isActive: row.status === "active",
      createdAt: row.createdAt.toISOString(),
      updatedAt: now,
      ...(isOauth
        ? {
            accessToken: credential,
            ...(row.refreshToken ? { refreshToken: decryptCredentialToString(row.refreshToken) } : {}),
            ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
          }
        : { apiKey: credential }),
      ...(row.providerId === "antigravity" && typeof authState.projectId === "string"
        ? { projectId: authState.projectId }
        : {}),
    });
  }

  // Combos: `members`/`strategy` map 1:1; round_robin keeps its router spelling.
  const combos = await db
    .select({ name: modelCombos.name, members: modelCombos.members, strategy: modelCombos.strategy })
    .from(modelCombos)
    .where(eq(modelCombos.tenantId, tenantId));
  const routerCombos = combos.map((c) => ({
    id: crypto.randomUUID(),
    name: c.name,
    kind: c.strategy === "round_robin" ? "round-robin" : null,
    models: c.members,
    createdAt: now,
    updatedAt: now,
  }));

  // Aliases: a plain name → target object, which is what the router stores.
  const aliases = await db
    .select({ alias: modelAliases.alias, target: modelAliases.targetModel })
    .from(modelAliases)
    .where(eq(modelAliases.tenantId, tenantId));
  const routerAliases: Record<string, string> = {};
  for (const a of aliases) routerAliases[a.alias] = a.target;

  // Custom models: only discovered/free-tier rows (the catalog's own builtin
  // rows already exist in the router's registry; re-exporting them would just
  // duplicate entries the router already serves).
  const extraModels = await db
    .select({ providerId: models.providerId, modelId: models.modelId, reasoning: models.reasoning, toolCall: models.toolCall, modalities: models.modalities })
    .from(models)
    .where(and(inArray(models.source, ["discovered", "auto_free"]), eq(models.enabled, true)));
  const routerCustomModels = extraModels
    .filter((m) => TO_ROUTER_ALIAS[m.providerId] !== undefined)
    .map((m) => {
      const modalities = (m.modalities ?? {}) as { input?: readonly string[] };
      return {
        providerAlias: TO_ROUTER_ALIAS[m.providerId],
        id: m.modelId,
        type: "llm",
        name: m.modelId,
        caps: {
          vision: Array.isArray(modalities.input) && modalities.input.includes("image"),
          reasoning: m.reasoning,
        },
      };
    });

  const payload: Record<string, unknown> = {
    providerConnections,
    providerNodes: [],
    proxyPools: [],
    apiKeys: [], // empty section: the router keeps its existing keys (hash-only export cannot carry plaintext)
    combos: routerCombos,
    modelAliases: routerAliases,
    customModels: routerCustomModels,
  };
  // Sections a router export always carries: send empty containers so the
  // receiving side sees a well-formed file; importDb treats empty arrays as
  // "wipe this section", so only send ones we genuinely own. `apiKeys: []`
  // would wipe keys — omit it instead.
  delete (payload as Record<string, unknown>).apiKeys;

  return {
    payload,
    counts: {
      providerConnections: providerConnections.length,
      combos: routerCombos.length,
      modelAliases: Object.keys(routerAliases).length,
      customModels: routerCustomModels.length,
    },
    omitted: [...omitted, ...(unmappedProviders.size > 0 ? [`unmapped providers: ${[...unmappedProviders].join(", ")}`] : [])],
  };
}
