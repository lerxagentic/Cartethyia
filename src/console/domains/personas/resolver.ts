// Custom Persona domain: request-path resolver for the active persona's text.
//
// The dispatch path needs the persona *content*, not just its id, and it must
// not add a query per request. This resolves `activePersonaId` → row and caches
// the text per (tenant, id), keyed by the same settings revision the
// preferences reader uses — so activating or editing a persona is visible on
// the next request without waiting out a TTL.

import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { personas } from "../../../persistence/schema";
import { currentSettingsRevision } from "../../../persistence/tenant-preferences";
import { TtlCache } from "../../../runtime/ttl-cache";

export interface ActivePersonaReader {
  /**
   * The active persona's content for a tenant, or null when none is active.
   * Failures resolve to null: a persona lookup outage must not fail an
   * otherwise dispatchable request (the caller's own prompt then stands).
   */
  read(tenantId: string, activePersonaId: string | null): Promise<string | null>;
}

interface CacheEntry {
  readonly revision: number;
  readonly content: string | null;
}

export class CachedActivePersonaReader implements ActivePersonaReader {
  private readonly cache: TtlCache<CacheEntry>;

  constructor(
    private readonly db: CartethyiaDatabase,
    opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.cache = new TtlCache<CacheEntry>({
      ttlMs: opts.ttlMs ?? 5_000,
      maxEntries: opts.maxEntries ?? 256,
      now: opts.now ?? Date.now,
    });
  }

  async read(tenantId: string, activePersonaId: string | null): Promise<string | null> {
    if (!activePersonaId) return null;
    const revision = currentSettingsRevision();
    const cacheKey = `${tenantId}:${activePersonaId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.revision === revision) return cached.content;
    try {
      const rows = await this.db
        .select({ content: personas.content })
        .from(personas)
        .where(and(eq(personas.tenantId, tenantId), eq(personas.id, activePersonaId)))
        .limit(1);
      const content = rows[0]?.content ?? null;
      this.cache.set(cacheKey, { revision, content });
      return content;
    } catch {
      return null;
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

let cached: { db: CartethyiaDatabase; reader: CachedActivePersonaReader } | undefined;

/**
 * Process-wide reader bound to a database identity, mirroring
 * `preferencesReaderFor`: production passes the same singleton every request,
 * tests use a different database per file.
 */
export function activePersonaReaderFor(db: CartethyiaDatabase): CachedActivePersonaReader {
  if (!cached || cached.db !== db) {
    cached = { db, reader: new CachedActivePersonaReader(db) };
  }
  return cached.reader;
}

export function clearActivePersonaCacheForTests(): void {
  cached?.reader.clear();
}
