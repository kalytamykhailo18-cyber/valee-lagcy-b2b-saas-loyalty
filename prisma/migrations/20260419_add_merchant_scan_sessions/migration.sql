CREATE TABLE "merchant_scan_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "branch_id" UUID,
  "consumer_phone" VARCHAR(32) NOT NULL,
  "scanned_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "merchant_scan_sessions_lookup_idx"
  ON "merchant_scan_sessions"("consumer_phone", "scanned_at" DESC);
