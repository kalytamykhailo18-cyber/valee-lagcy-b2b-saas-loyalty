CREATE TABLE "staff_scan_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "staff_id" UUID NOT NULL,
  "consumer_phone" VARCHAR(32) NOT NULL,
  "scanned_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "staff_scan_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE
);
CREATE INDEX "staff_scan_sessions_lookup_idx" ON "staff_scan_sessions"("tenant_id", "consumer_phone", "scanned_at" DESC);
