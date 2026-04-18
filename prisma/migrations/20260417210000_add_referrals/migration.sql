-- Account referral slug
ALTER TABLE "accounts" ADD COLUMN "referral_slug" VARCHAR(16);
CREATE UNIQUE INDEX "accounts_referral_slug_key" ON "accounts"("referral_slug");

-- Tenant referral bonus config
ALTER TABLE "tenants" ADD COLUMN "referral_bonus_amount" INTEGER NOT NULL DEFAULT 100;

-- Referral status enum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'credited', 'rejected');

-- Referrals table
CREATE TABLE "referrals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "referrer_account_id" UUID NOT NULL,
  "referee_account_id" UUID NOT NULL,
  "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
  "bonus_amount" DECIMAL(18, 8),
  "bonus_ledger_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "credited_at" TIMESTAMPTZ,
  CONSTRAINT "referrals_referrer_fkey" FOREIGN KEY ("referrer_account_id") REFERENCES "accounts"("id"),
  CONSTRAINT "referrals_referee_fkey"  FOREIGN KEY ("referee_account_id")  REFERENCES "accounts"("id"),
  CONSTRAINT "referrals_tenant_referee_unique" UNIQUE ("tenant_id", "referee_account_id")
);
CREATE INDEX "referrals_by_referrer_idx" ON "referrals"("tenant_id", "referrer_account_id");
CREATE INDEX "referrals_pending_idx"     ON "referrals"("status", "created_at");
