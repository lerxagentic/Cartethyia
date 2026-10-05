/**
 * Live gateway probe: sends one chat + one messages request through the real
 * HTTP gateway using the tenant's recoverable default key, printing status and
 * the response head. Verifies the cross-surface translation end to end.
 *
 *   bun scripts/gateway-probe.ts <provider/model> [surface=chat|messages|responses]
 */
import { getDb } from "../src/persistence/postgres";
import { apiKeys } from "../src/persistence/schema";
import { decryptCredentialToString } from "../src/security/crypto";

const target = process.argv[2] ?? "cb/glm-5.3";
const surface = process.argv[3] ?? "chat";

const db = getDb();
const rows = await db.select().from(apiKeys).limit(5);
const withSecret = rows.find((r) => r.keyEncrypted !== null && r.revokedAt === null);
if (!withSecret?.keyEncrypted) {
  console.error("no recoverable key");
  process.exit(1);
}
const secret = decryptCredentialToString(withSecret.keyEncrypted);

const base = process.env.CARTETHYIA_PUBLIC_ORIGIN ?? "http://127.0.0.1:12800";
const url =
  surface === "messages" ? `${base}/v1/messages`
  : surface === "responses" ? `${base}/v1/responses`
  : `${base}/v1/chat/completions`;

const body =
  surface === "messages"
    ? { model: target, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly: ping" }] }
    : surface === "responses"
      ? { model: target, max_output_tokens: 32, input: "Reply with exactly: ping" }
      : { model: target, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly: ping" }] };

const headers: Record<string, string> = { "content-type": "application/json" };
if (surface === "messages") { headers["x-api-key"] = secret; headers["anthropic-version"] = "2023-06-01"; }
else headers["authorization"] = `Bearer ${secret}`;

const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
const text = await res.text();
console.log(`POST ${url}`);
console.log(`HTTP ${res.status}`);
console.log(text.slice(0, 600));
process.exit(0);
