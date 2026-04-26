-- Dual-scan session persistence. Genesis 2026-04-24: the "Pago en
-- efectivo" QR encoded a base64 JSON HMAC token (~500 chars) which
-- forced the QR to version ~14 with dense modules that scanners could
-- not lock. We move the payload into a DB session row and let the QR
-- carry only a short nonce — dropping the QR to version 3-4.
CREATE TABLE "dual_scan_sessions" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id"     UUID NULL REFERENCES "branches"("id") ON DELETE SET NULL,
  "cashier_id"    UUID NOT NULL REFERENCES "staff"("id") ON DELETE RESTRICT,
  "amount"        DECIMAL(18, 8) NOT NULL,
  "asset_type_id" UUID NOT NULL REFERENCES "asset_types"("id") ON DELETE RESTRICT,
  "nonce"         VARCHAR(32) NOT NULL UNIQUE,
  "status"        VARCHAR(16) NOT NULL DEFAULT 'pending',
  "expires_at"    TIMESTAMPTZ NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "dual_scan_sessions_tenant_cashier_idx"
  ON "dual_scan_sessions" ("tenant_id", "cashier_id", "created_at" DESC);

CREATE INDEX "dual_scan_sessions_status_expires_idx"
  ON "dual_scan_sessions" ("status", "expires_at");
