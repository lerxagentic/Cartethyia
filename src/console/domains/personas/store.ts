// Custom Persona domain: Drizzle store.
//
// Owns persistence and the row shape; routes never touch Drizzle.

import { and, desc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { personas } from "../../../persistence/schema";
import type { Persona as PersonaRow } from "../../../persistence/schema";
import type { PersonaStore } from "./contracts";

export class DrizzlePersonaStore implements PersonaStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async list(tenantId: string): Promise<readonly PersonaRow[]> {
    return this.db
      .select()
      .from(personas)
      .where(eq(personas.tenantId, tenantId))
      .orderBy(desc(personas.updatedAt));
  }

  async listIdsOldestFirst(tenantId: string): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.tenantId, tenantId))
      .orderBy(personas.updatedAt);
    return rows.map((row) => row.id);
  }

  async get(tenantId: string, id: string): Promise<PersonaRow | undefined> {
    const rows = await this.db
      .select()
      .from(personas)
      .where(and(eq(personas.tenantId, tenantId), eq(personas.id, id)))
      .limit(1);
    return rows[0];
  }

  async create(row: PersonaRow): Promise<void> {
    await this.db.insert(personas).values({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      content: row.content,
    });
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<PersonaRow> & { updatedAt: Date },
  ): Promise<PersonaRow | undefined> {
    const rows = await this.db
      .update(personas)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.content === undefined ? {} : { content: patch.content }),
        updatedAt: patch.updatedAt,
      })
      .where(and(eq(personas.tenantId, tenantId), eq(personas.id, id)))
      .returning();
    return rows[0];
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(personas)
      .where(and(eq(personas.tenantId, tenantId), eq(personas.id, id)))
      .returning({ id: personas.id });
    return rows.length > 0;
  }
}
