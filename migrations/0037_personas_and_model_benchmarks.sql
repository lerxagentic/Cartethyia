-- Custom personas and model benchmarks.
--
-- `personas` holds operator-authored system prompts; the active one is named by
-- `console_settings.preferences.activePersonaId` (JSONB, so no column change).
-- `model_benchmarks` holds latency/throughput samples used to rank models.

CREATE TABLE IF NOT EXISTS "personas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personas_tenant_updated_idx" ON "personas" ("tenant_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_benchmarks" (
  "id" text PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "model" text NOT NULL,
  "provider" text,
  "ok" boolean NOT NULL,
  "latency_ms" integer,
  "ttft_ms" integer,
  "output_tokens" integer,
  "error" text,
  "at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_benchmarks_tenant_model_at_idx"
  ON "model_benchmarks" ("tenant_id", "model", "at");
