/**
 * Scheduled native backup over Telegram — the Cartethyia counterpart of
 * 9Router's `telegramBackup` auto-backup. Exports the same native payload as
 * `GET /backup/export` (config + telemetry sections, per-tenant) and ships it
 * to the operator's bot chat as a `sendDocument` attachment.
 *
 * Config lives in `console_settings.preferences.autoBackup` so a backup
 * restore preserves it (exactly how 9Router persists its schedule in the
 * autoBackup KV scope). The scheduler reads it on every pass, so a settings
 * change takes effect within one tick; `lastSentAt`/`lastError` are stamped
 * back into the row so restarts never re-send and failures are visible.
 *
 * Security note: the bot token is a sender credential, stored like every
 * other secret in this table — present in native exports by design (a restore
 * must reproduce the deployment). Never log it.
 */
import { log } from "../observability/logger";
import { exportBackup } from "../console/backup/store";
import { tablesForSection } from "../console/backup/contracts";
import type { CartethyiaDatabase } from "../persistence/postgres";
import { consoleSettings, tenants } from "../persistence/schema";
import { eq } from "drizzle-orm";
import type { ScheduledTaskRegistry } from "./tasks";

export interface AutoBackupConfig {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly fetcher?: typeof fetch | undefined;
  /** Skip the interval gate — used by the dashboard's "send now" action. */
  readonly force?: boolean;
}

interface AutoBackupPrefs {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  intervalHours?: number;
  lastSentAt?: string | null;
  lastError?: string | null;
}

const MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // Telegram bot document upload limit is 50 MB.

export async function runAutoBackupForTenant(config: AutoBackupConfig): Promise<{ sent: boolean; error?: string }> {
  const settings = await loadAutoBackupPrefs(config.db, config.tenantId);
  const ab = settings?.autoBackup as AutoBackupPrefs | undefined;
  if (!ab?.enabled || !ab.botToken || !ab.chatId) {
    return { sent: false };
  }
  const hours = typeof ab.intervalHours === "number" && Number.isFinite(ab.intervalHours) && ab.intervalHours > 0 ? ab.intervalHours : 24;
  const intervalMs = Math.max(MIN_INTERVAL_MS, hours * 60 * 60 * 1000);
  const lastSentAt = typeof ab.lastSentAt === "string" ? Date.parse(ab.lastSentAt) : NaN;
  if (config.force !== true && Number.isFinite(lastSentAt) && Date.now() - lastSentAt < intervalMs) {
    return { sent: false };
  }

  const exporter = config.fetcher ?? fetch.bind(globalThis);
  try {
    const { payload } = await exportBackup(
      config.db,
      [...tablesForSection("config"), ...tablesForSection("telemetry")],
      config.tenantId,
    );
    const buf = Buffer.from(JSON.stringify(payload, null, 2));
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(`backup too large for Telegram (${(buf.length / 1024 / 1024).toFixed(1)} MB > 50 MB)`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const form = new FormData();
    form.append("chat_id", ab.chatId);
    form.append("document", new Blob([buf], { type: "application/json" }), `cartethyia-backup-${stamp}.json`);
    form.append("caption", `Cartethyia auto backup ${new Date().toISOString()} — ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    const res = await exporter(`https://api.telegram.org/bot${ab.botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`telegram sendDocument failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    await stampAutoBackupResult(config.db, config.tenantId, { lastSentAt: new Date().toISOString(), lastError: null });
    log.info("[auto-backup] sent backup to telegram", { tenantId: config.tenantId, bytes: buf.length });
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stampAutoBackupResult(config.db, config.tenantId, { lastSentAt: null, lastError: message });
    log.error("[auto-backup] failed", error as Error);
    return { sent: false, error: message };
  }
}

async function loadAutoBackupPrefs(db: CartethyiaDatabase, tenantId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select({ preferences: consoleSettings.preferences }).from(consoleSettings).where(eq(consoleSettings.tenantId, tenantId));
  return rows[0]?.preferences as Record<string, unknown> | undefined;
}

/** Re-reads the row (preserving every other preference) and stamps the auto-backup scheduler state. */
async function stampAutoBackupResult(
  db: CartethyiaDatabase,
  tenantId: string,
  patch: { lastSentAt: string | null; lastError: string | null },
): Promise<void> {
  const rows = await db.select({ preferences: consoleSettings.preferences }).from(consoleSettings).where(eq(consoleSettings.tenantId, tenantId));
  const prefs = (rows[0]?.preferences ?? {}) as Record<string, unknown>;
  const prev = (prefs.autoBackup ?? {}) as Record<string, unknown>;
  const next = {
    ...prefs,
    autoBackup: {
      ...prev,
      ...(patch.lastSentAt === null ? {} : { lastSentAt: patch.lastSentAt }),
      lastError: patch.lastError,
    },
  };
  await db.update(consoleSettings).set({ preferences: next as never, updatedAt: new Date() }).where(eq(consoleSettings.tenantId, tenantId));
}

export function registerAutoBackupTask(deps: {
  readonly db: CartethyiaDatabase;
  readonly scheduledTasks: ScheduledTaskRegistry;
  readonly fetcher?: typeof fetch | undefined;
}): void {
  deps.scheduledTasks.register({
    name: "auto-backup-telegram",
    // Hourly sweep; per-tenant intervalHours gates actual cadence.
    intervalMs: 60 * 60 * 1000,
    run: async () => {
      const allTenants = await deps.db.select({ id: tenants.id }).from(tenants);
      for (const t of allTenants) {
        await runAutoBackupForTenant({ db: deps.db, tenantId: t.id, fetcher: deps.fetcher });
      }
    },
  });
}
