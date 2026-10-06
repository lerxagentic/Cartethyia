// Custom Persona domain: the tenant's `activePersonaId` preference.
//
// Activation lives in `console_settings.preferences` (JSONB) rather than a
// column on `personas`, so the request path resolves it through the existing
// cached preferences reader and a settings write is the single mutation point.

import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { consoleSettings } from "../../../persistence/schema";
import { bumpSettingsRevision } from "../../../persistence/tenant-preferences";
import type { ActivePersonaPort } from "./contracts";

export class DrizzleActivePersona implements ActivePersonaPort {
  constructor(private readonly db: CartethyiaDatabase) {}

  async read(tenantId: string): Promise<string | null> {
    const rows = await this.db
      .select({ preferences: consoleSettings.preferences })
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    const active = rows[0]?.preferences?.activePersonaId;
    return typeof active === "string" && active.length > 0 ? active : null;
  }

  async write(tenantId: string, personaId: string | null): Promise<void> {
    const now = new Date();
    // `null` clears the key rather than storing it, so "no persona" and "a
    // persona whose id happens to be empty" cannot be confused on read.
    const patch = { activePersonaId: personaId } as const;
    await this.db
      .insert(consoleSettings)
      .values({ tenantId, preferences: { activePersonaId: personaId }, updatedAt: now })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: {
          preferences:
            personaId === null
              ? sql`${consoleSettings.preferences} - 'activePersonaId'`
              : sql`${consoleSettings.preferences} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: now,
        },
      });
    // The preferences reader caches by revision; bumping it makes the new
    // active persona visible to the very next request instead of after the TTL.
    bumpSettingsRevision();
  }
}
