-- Origin cashier for chain-referral attribution. When a consumer scans a
-- cashier's QR, shares their referral code with someone, and that referee
-- validates an invoice, the cashier should get credit in staff-performance
-- metrics. We stamp the referrer's origin cashier on the Referral row at
-- record time and later look it up when computing staff metrics.
ALTER TABLE "referrals"
  ADD COLUMN "origin_staff_id" UUID NULL,
  ADD CONSTRAINT "referrals_origin_staff_id_fkey"
    FOREIGN KEY ("origin_staff_id") REFERENCES "staff"("id") ON DELETE SET NULL;

CREATE INDEX "referrals_origin_staff_idx"
  ON "referrals" ("tenant_id", "origin_staff_id", "status");

-- Backfill for existing referrals: pick the origin cashier from the
-- referrer's most recent INVOICE_CLAIMED or PRESENCE_VALIDATED ledger row
-- that has a staffId in metadata. Retroactive attribution so historic
-- referrals (like Genesis's test today) land in the cashier metrics.
UPDATE "referrals" r
SET "origin_staff_id" = latest_staff.staff_uuid
FROM (
  SELECT DISTINCT ON (le.account_id)
         le.account_id,
         (le.metadata->>'staffId')::uuid AS staff_uuid
  FROM ledger_entries le
  WHERE le.event_type IN ('INVOICE_CLAIMED', 'PRESENCE_VALIDATED')
    AND le.entry_type = 'CREDIT'
    AND le.metadata->>'staffId' IS NOT NULL
  ORDER BY le.account_id, le.created_at DESC
) latest_staff
WHERE latest_staff.account_id = r.referrer_account_id
  AND r.origin_staff_id IS NULL;

-- Fallback backfill: referrers who never had a staff-attributed invoice
-- but did have a StaffScanSession row — use the most recent.
UPDATE "referrals" r
SET "origin_staff_id" = latest_scan.staff_uuid
FROM (
  SELECT DISTINCT ON (a.id)
         a.id AS account_id,
         sss.staff_id AS staff_uuid
  FROM staff_scan_sessions sss
  JOIN accounts a ON a.phone_number = sss.consumer_phone
                 AND a.tenant_id    = sss.tenant_id
  ORDER BY a.id, sss.scanned_at DESC
) latest_scan
WHERE latest_scan.account_id = r.referrer_account_id
  AND r.origin_staff_id IS NULL;
