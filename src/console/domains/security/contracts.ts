import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import type { ModelAbuseBan, ModelStrikeService } from "../../../security/model-abuse";
import { errorResponse, requireGlobalAdmin } from "../../shared/errors";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { telemetryEvents, consoleLockouts, adminAuditLog } from "../../../persistence/schema";
import { desc, sql, and, gte, eq, or, ilike } from "drizzle-orm";

export interface SecurityRoutesConfig {
  readonly db: CartethyiaDatabase;
  readonly strikes?: Pick<ModelStrikeService, "listBans" | "unban"> | undefined;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
}

export function createSecurityRoutes(config: SecurityRoutesConfig): Elysia {
  return new Elysia()
    .get("/security/overview", async ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));

        // 1. Top IPs with counts and errors
        const topIps = await config.db.execute(sql`
          SELECT 
            COALESCE(client_ip, 'unknown') as ip,
            count(*)::int as total_requests,
            count(*) FILTER (WHERE http_status >= 400)::int as error_requests,
            count(*) FILTER (WHERE http_status = 401 OR http_status = 403)::int as blocked_requests,
            MAX(created_at) as last_seen,
            MAX(user_agent) as sample_user_agent
          FROM telemetry_events
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY client_ip
          ORDER BY total_requests DESC
          LIMIT 20
        `);

        // 2. Suspicious activities (401, 403, 429, 404, or known scanners)
        const suspiciousEvents = await config.db.execute(sql`
          SELECT 
            id,
            created_at,
            client_ip,
            user_agent,
            endpoint,
            http_status,
            error_category,
            error_origin,
            status
          FROM telemetry_events
          WHERE http_status >= 400 OR error_category IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 50
        `);

        // 3. Active Bans (from strikes and consoleLockouts)
        const activeBans: Array<{ ip: string; expiresAt?: string | number; reason?: string }> = [];
        if (config.strikes) {
          try {
            const strikeBans = await config.strikes.listBans();
            for (const b of strikeBans) {
              activeBans.push({ ip: b.ip, expiresAt: b.expiresAt, reason: "Model Abuse (Too many invalid probes)" });
            }
          } catch {
            // Ignore if redis is unavailable
          }
        }

        const lockouts = await config.db.select().from(consoleLockouts).where(gte(consoleLockouts.lockedUntil, new Date()));
        for (const l of lockouts) {
          activeBans.push({
            ip: l.ip,
            expiresAt: l.lockedUntil?.toISOString(),
            reason: l.reason ?? "Login lockout (Repeated failures)",
          });
        }

        // 4. Unique User Agents summary
        const topUserAgents = await config.db.execute(sql`
          SELECT 
            COALESCE(user_agent, 'unknown') as user_agent,
            count(*)::int as total_requests,
            count(*) FILTER (WHERE http_status >= 400)::int as error_requests,
            MAX(created_at) as last_seen
          FROM telemetry_events
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY user_agent
          ORDER BY total_requests DESC
          LIMIT 15
        `);

        return {
          topIps: topIps.rows,
          suspiciousEvents: suspiciousEvents.rows,
          activeBans,
          topUserAgents: topUserAgents.rows,
        };
      } catch (e) {
        return errorResponse(e, set, "Security overview read failed");
      }
    })
    .get("/security/events", async ({ request, query, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const limit = Math.min(Number(query.limit) || 50, 200);
        const search = query.search ? String(query.search).trim() : "";
        const errorsOnly = query.errorsOnly === "true";

        let whereClause = sql`TRUE`;
        if (errorsOnly) {
          whereClause = sql`${whereClause} AND (http_status >= 400 OR error_category IS NOT NULL)`;
        }
        if (search) {
          const pattern = `%${search}%`;
          whereClause = sql`${whereClause} AND (client_ip ILIKE ${pattern} OR user_agent ILIKE ${pattern} OR endpoint ILIKE ${pattern})`;
        }

        const events = await config.db.execute(sql`
          SELECT 
            id,
            created_at,
            client_ip,
            user_agent,
            endpoint,
            requested_model,
            http_status,
            latency_ms,
            error_category,
            error_origin,
            status
          FROM telemetry_events
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `);

        return { events: events.rows };
      } catch (e) {
        return errorResponse(e, set, "Security events query failed");
      }
    })
    .post("/security/ban", async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const b = body as { ip: string; reason?: string; durationMinutes?: number };
        if (!b.ip || typeof b.ip !== "string") {
          set.status = 400;
          return { error: "Missing ip parameter" };
        }
        const durationMinutes = Number(b.durationMinutes) || 1440; // Default 24 hours
        const lockedUntil = new Date(Date.now() + durationMinutes * 60_000);
        const reason = b.reason ?? "Manual administrative ban";

        await config.db.insert(consoleLockouts).values({
          ip: b.ip,
          failureCount: 999,
          lockedUntil,
          reason,
        }).onConflictDoUpdate({
          target: consoleLockouts.ip,
          set: {
            failureCount: 999,
            lockedUntil,
            reason,
            updatedAt: new Date(),
          },
        });

        // Audit log
        await config.db.insert(adminAuditLog).values({
          actor: "admin:manual",
          action: "security.ip_banned",
          target: `ip:${b.ip}`,
          detail: {
            ip: b.ip,
            reason,
            durationMinutes,
            bannedUntil: lockedUntil.toISOString(),
          },
        });

        return { success: true, bannedUntil: lockedUntil.toISOString() };
      } catch (e) {
        return errorResponse(e, set, "Manual ban failed");
      }
    })
    .delete("/security/ban", async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const b = body as { ip: string };
        if (!b.ip || typeof b.ip !== "string") {
          set.status = 400;
          return { error: "Missing ip parameter" };
        }

        // Lift DB lockout
        await config.db.delete(consoleLockouts).where(eq(consoleLockouts.ip, b.ip));

        // Lift strike ban if available
        if (config.strikes) {
          try {
            await config.strikes.unban(b.ip);
          } catch {}
        }

        // Audit log
        await config.db.insert(adminAuditLog).values({
          actor: "admin:manual",
          action: "security.ip_unbanned",
          target: `ip:${b.ip}`,
          detail: { ip: b.ip },
        });

        return { success: true };
      } catch (e) {
        return errorResponse(e, set, "Unban failed");
      }
    }) as unknown as Elysia;
}
