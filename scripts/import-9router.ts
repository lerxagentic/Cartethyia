/**
 * Imports a 9Router JSON export into Cartethyia's Postgres using the same
 * conversion + validation + single-transaction restore path the console
 * backup-import endpoint uses (BackupService.restore -> convert9RouterBackup
 * -> validateRestorePayload -> applyRestore).
 *
 * Usage:
 *   bun scripts/import-9router.ts <backup-json-path> [tenant-name-or-id]
 *
 * The script NEVER bypasses conversion or validation: it only bypasses the
 * password check (console operator auth), since it runs with shell access.
 */
import { readFile } from "node:fs/promises";
import { getDb } from "../src/persistence/postgres";
import { tenants } from "../src/persistence/schema";
import { convert9RouterBackup } from "../src/console/backup/nine-router";
import { validateRestorePayload, restoreOrder } from "../src/console/backup/validate";
import { applyRestore } from "../src/console/backup/store";

const backupPath = process.argv[2];
const tenantHint = process.argv[3] ?? "Default";
if (!backupPath) {
  console.error("usage: bun scripts/import-9router.ts <backup-json-path> [tenant-name-or-id]");
  process.exit(1);
}

const db = getDb();
const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
const row = tenantRows.find((t) => t.id === tenantHint || t.name === tenantHint);
if (row === undefined) {
  console.error(`tenant "${tenantHint}" not found. Available: ${tenantRows.map((t) => t.name).join(", ")}`);
  process.exit(1);
}
const tenantId: string = row.id;

const raw = JSON.parse(await readFile(backupPath, "utf8"));
console.log(`converting backup for tenant ${tenantId} ...`);
const { payload, report } = convert9RouterBackup(raw, tenantId);

console.log("--- conversion report ---");
console.log(`skipped (${report.skipped.length}):`);
for (const s of report.skipped) console.log(`  - ${s}`);
console.log(`warnings (${report.warnings.length}):`);
for (const w of report.warnings) console.log(`  - ${w}`);
console.log(`remapped: ${[...report.remapped].join(", ") || "(none)"}`);

const validation = validateRestorePayload(payload, tenantId);
if (!validation.ok) {
  console.error("VALIDATION FAILED:", validation.error);
  process.exit(1);
}
console.log("validation: OK");

const result = await applyRestore(db, validation.value, restoreOrder(), tenantId);
console.log("--- restore result ---");
console.log(JSON.stringify(result, null, 2));
console.log("done.");
