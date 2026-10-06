// Custom Persona domain: persisted persona model, operations, and HTTP routes.
//
// A persona is an operator-authored system prompt. When one is active for a
// tenant, its text REPLACES the system content the client sent, so every model
// called through the router follows the router's instruction rather than the
// caller's. Activation is a single settings write (`activePersonaId`) so the
// hot request path reads it through the already-cached preferences reader.

import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import { isRecord } from "../../../protocol/primitives";
import type { Persona as PersonaRow } from "../../../persistence/schema";

/** A saved persona as returned to the dashboard. */
export interface PersonaView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Storage bounds: a persona is a prompt, not a document store. */
export const PERSONA_MAX_PER_TENANT = 100;
export const PERSONA_LIMIT_NAME = 200;
export const PERSONA_LIMIT_DESCRIPTION = 1_000;
export const PERSONA_LIMIT_CONTENT = 200_000;

export interface PersonaStore {
  list(tenantId: string): Promise<readonly PersonaRow[]>;
  listIdsOldestFirst(tenantId: string): Promise<readonly string[]>;
  get(tenantId: string, id: string): Promise<PersonaRow | undefined>;
  create(row: PersonaRow): Promise<void>;
  update(
    tenantId: string,
    id: string,
    patch: Partial<PersonaRow> & { updatedAt: Date },
  ): Promise<PersonaRow | undefined>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface PersonaConfig {
  readonly store: PersonaStore;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
  /** Reads/writes the tenant's `activePersonaId` preference. */
  readonly activePersona: ActivePersonaPort;
}

/**
 * The slice of settings this domain needs. Kept narrow so persona activation
 * does not drag the whole runtime-settings store into the persona domain.
 */
export interface ActivePersonaPort {
  read(tenantId: string): Promise<string | null>;
  write(tenantId: string, personaId: string | null): Promise<void>;
}

export function toPersonaView(row: PersonaRow): PersonaView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConsoleDomainError("invalid_persona", 400, `${field} is required`);
  }
  if (value.length > max) {
    throw new ConsoleDomainError("invalid_persona", 400, `${field} exceeds ${max} characters`);
  }
  return value;
}

function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ConsoleDomainError("invalid_persona", 400, "description must be a string");
  }
  if (value.length > max) {
    throw new ConsoleDomainError("invalid_persona", 400, `description exceeds ${max} characters`);
  }
  return value;
}

export function createPersonaOperations(config: PersonaConfig) {
  const store = config.store;

  async function list(access: AccessDecision | undefined): Promise<{ items: PersonaView[]; activeId: string | null }> {
    const authorized = requireTenantScope(access, "dashboard:read");
    const [rows, activeId] = await Promise.all([
      store.list(authorized.tenantId),
      config.activePersona.read(authorized.tenantId),
    ]);
    return { items: rows.map(toPersonaView), activeId };
  }

  async function get(access: AccessDecision | undefined, id: string): Promise<PersonaView> {
    const authorized = requireTenantScope(access, "dashboard:read");
    const row = await store.get(authorized.tenantId, id);
    if (!row) throw new ConsoleDomainError("persona_not_found", 404, "persona not found");
    return toPersonaView(row);
  }

  async function create(
    access: AccessDecision | undefined,
    input: { name?: unknown; description?: unknown; content?: unknown },
  ): Promise<PersonaView> {
    const authorized = requireTenantScope(access, "dashboard:write");
    const existing = await store.listIdsOldestFirst(authorized.tenantId);
    if (existing.length >= PERSONA_MAX_PER_TENANT) {
      throw new ConsoleDomainError(
        "persona_limit_reached",
        409,
        `at most ${PERSONA_MAX_PER_TENANT} personas are kept; delete one first`,
      );
    }
    const now = new Date();
    const row: PersonaRow = {
      id: randomUUID(),
      tenantId: authorized.tenantId,
      name: requiredText(input.name, "name", PERSONA_LIMIT_NAME),
      description: optionalText(input.description, PERSONA_LIMIT_DESCRIPTION),
      content: requiredText(input.content, "content", PERSONA_LIMIT_CONTENT),
      createdAt: now,
      updatedAt: now,
    };
    await store.create(row);
    return toPersonaView(row);
  }

  async function patch(
    access: AccessDecision | undefined,
    id: string,
    input: { name?: unknown; description?: unknown; content?: unknown },
  ): Promise<PersonaView> {
    const authorized = requireTenantScope(access, "dashboard:write");
    const existing = await store.get(authorized.tenantId, id);
    if (!existing) throw new ConsoleDomainError("persona_not_found", 404, "persona not found");
    const patchRow: Partial<PersonaRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.name !== undefined) patchRow.name = requiredText(input.name, "name", PERSONA_LIMIT_NAME);
    if (input.description !== undefined)
      patchRow.description = optionalText(input.description, PERSONA_LIMIT_DESCRIPTION);
    if (input.content !== undefined)
      patchRow.content = requiredText(input.content, "content", PERSONA_LIMIT_CONTENT);
    const updated = await store.update(authorized.tenantId, id, patchRow);
    if (!updated) throw new ConsoleDomainError("persona_not_found", 404, "persona not found");
    return toPersonaView(updated);
  }

  async function remove(access: AccessDecision | undefined, id: string): Promise<void> {
    const authorized = requireTenantScope(access, "dashboard:write");
    const removed = await store.delete(authorized.tenantId, id);
    if (!removed) throw new ConsoleDomainError("persona_not_found", 404, "persona not found");
    // Clearing an active persona must not leave a dangling id pointing at a
    // deleted row: the request path resolves the id to a row and silently skips
    // an unknown one, but leaving it set would look "active" in the UI.
    const activeId = await config.activePersona.read(authorized.tenantId);
    if (activeId === id) await config.activePersona.write(authorized.tenantId, null);
  }

  /** Activates a persona, or clears the active one when `id` is null. */
  async function activate(
    access: AccessDecision | undefined,
    id: string | null,
  ): Promise<{ activeId: string | null }> {
    const authorized = requireTenantScope(access, "dashboard:write");
    if (id !== null) {
      const row = await store.get(authorized.tenantId, id);
      if (!row) throw new ConsoleDomainError("persona_not_found", 404, "persona not found");
    }
    await config.activePersona.write(authorized.tenantId, id);
    return { activeId: id };
  }

  return { list, get, create, patch, remove, activate };
}

export function createPersonaRoutes(config: PersonaConfig): Elysia {
  const operations = createPersonaOperations(config);
  return new Elysia({ prefix: "/personas" })
    .get("/", async ({ request, set }) => {
      try {
        return await operations.list(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    })
    .get("/:id", async ({ request, params, set }) => {
      try {
        return await operations.get(config.accessResolver(request), params.id);
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    })
    .post("/", async ({ request, body, set }) => {
      try {
        set.status = 201;
        const input = isRecord(body) ? body : {};
        return await operations.create(config.accessResolver(request), {
          name: input["name"],
          description: input["description"],
          content: input["content"],
        });
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    })
    .patch("/:id", async ({ request, params, body, set }) => {
      try {
        const input = isRecord(body) ? body : {};
        return await operations.patch(config.accessResolver(request), params.id, {
          name: input["name"],
          description: input["description"],
          content: input["content"],
        });
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    })
    .delete("/:id", async ({ request, params, set }) => {
      try {
        await operations.remove(config.accessResolver(request), params.id);
        return { success: true };
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    })
    .put("/active", async ({ request, body, set }) => {
      try {
        const input = isRecord(body) ? body : {};
        const raw = input["personaId"];
        const id = raw === null || raw === undefined || raw === "" ? null : String(raw);
        return await operations.activate(config.accessResolver(request), id);
      } catch (error) {
        return errorResponse(error, set, "Persona operation failed");
      }
    }) as unknown as Elysia;
}
