-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('shadow', 'verified', 'system');

-- CreateEnum
CREATE TYPE "SystemAccountType" AS ENUM ('issued_value_pool', 'redemption_holding');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('INVOICE_CLAIMED', 'REDEMPTION_PENDING', 'REDEMPTION_CONFIRMED', 'REDEMPTION_EXPIRED', 'REVERSAL', 'ADJUSTMENT_MANUAL', 'TRANSFER_P2P');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerReferenceType" AS ENUM ('invoice', 'redemption_token', 'manual_adjustment', 'transfer', 'system');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('confirmed', 'provisional', 'reversed');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('available', 'claimed', 'pending_validation', 'rejected', 'manual_review');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('csv_upload', 'photo_submission');

-- CreateEnum
CREATE TYPE "UploadBatchStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "RedemptionTokenStatus" AS ENUM ('pending', 'used', 'expired');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('owner', 'cashier');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('staff', 'admin');

-- CreateEnum
CREATE TYPE "AuditActorRole" AS ENUM ('owner', 'cashier', 'admin');

-- CreateEnum
CREATE TYPE "AuditActionType" AS ENUM ('QR_SCAN_SUCCESS', 'QR_SCAN_FAILURE', 'IDENTITY_UPGRADE', 'CUSTOMER_LOOKUP', 'CSV_UPLOAD', 'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_TOGGLED', 'STAFF_CREATED', 'STAFF_DEACTIVATED', 'MANUAL_ADJUSTMENT', 'DISPUTE_APPROVED', 'DISPUTE_REJECTED', 'DISPUTE_ESCALATED', 'TENANT_CREATED', 'TENANT_DEACTIVATED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'approved', 'rejected', 'escalated');

-- CreateEnum
CREATE TYPE "DisputeResolverType" AS ENUM ('staff', 'admin');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "owner_email" VARCHAR(255) NOT NULL,
    "qr_code_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "address" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "qr_code_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_types" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "unit_label" VARCHAR(50) NOT NULL,
    "default_conversion_rate" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_asset_config" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "conversion_rate" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_asset_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone_number" VARCHAR(30),
    "cedula" VARCHAR(20),
    "account_type" "AccountType" NOT NULL,
    "system_account_type" "SystemAccountType",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" "LedgerEventType" NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "account_id" UUID NOT NULL,
    "paired_entry_id" UUID,
    "amount" DECIMAL(18,8) NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "reference_id" VARCHAR(255) NOT NULL,
    "reference_type" "LedgerReferenceType" NOT NULL,
    "branch_id" UUID,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "device_id" VARCHAR(255),
    "status" "LedgerStatus" NOT NULL DEFAULT 'confirmed',
    "prev_hash" VARCHAR(64),
    "hash" VARCHAR(64) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "invoice_number" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "transaction_date" TIMESTAMPTZ,
    "customer_phone" VARCHAR(30),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'available',
    "source" "InvoiceSource" NOT NULL,
    "upload_batch_id" UUID,
    "consumer_account_id" UUID,
    "ledger_entry_id" UUID,
    "ocr_raw_text" TEXT,
    "extracted_data" JSONB,
    "confidence_score" DECIMAL(4,3),
    "submitted_latitude" DECIMAL(10,7),
    "submitted_longitude" DECIMAL(10,7),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "file_url" TEXT,
    "status" "UploadBatchStatus" NOT NULL DEFAULT 'queued',
    "rows_loaded" INTEGER,
    "rows_skipped" INTEGER,
    "rows_errored" INTEGER,
    "error_details" JSONB,
    "uploaded_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consumer_account_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "status" "RedemptionTokenStatus" NOT NULL DEFAULT 'pending',
    "token_signature" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "used_by_staff_id" UUID,
    "branch_id" UUID,
    "ledger_pending_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemption_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "photo_url" TEXT,
    "redemption_cost" DECIMAL(18,8) NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "StaffRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_role" "AuditActorRole" NOT NULL,
    "action_type" "AuditActionType" NOT NULL,
    "consumer_account_id" UUID,
    "amount" DECIMAL(18,8),
    "outcome" "AuditOutcome" NOT NULL,
    "failure_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consumer_account_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "screenshot_url" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolver_id" UUID,
    "resolver_type" "DisputeResolverType",
    "resolution_reason" TEXT,
    "ledger_adjustment_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "resource_type" VARCHAR(100) NOT NULL,
    "result" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_sessions" (
    "id" UUID NOT NULL,
    "phone_number" VARCHAR(30) NOT NULL,
    "otp_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "branches_tenant_id_idx" ON "branches"("tenant_id");

-- CreateIndex
CREATE INDEX "branches_tenant_id_active_idx" ON "branches"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "asset_types_name_key" ON "asset_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_asset_config_tenant_id_asset_type_id_key" ON "tenant_asset_config"("tenant_id", "asset_type_id");

-- CreateIndex
CREATE INDEX "accounts_tenant_id_account_type_idx" ON "accounts"("tenant_id", "account_type");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_phone_number_key" ON "accounts"("tenant_id", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_cedula_key" ON "accounts"("tenant_id", "cedula");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenant_id_system_account_type_key" ON "accounts"("tenant_id", "system_account_type");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_account_id_idx" ON "ledger_entries"("tenant_id", "account_id");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_event_type_idx" ON "ledger_entries"("tenant_id", "event_type");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_reference_id_idx" ON "ledger_entries"("tenant_id", "reference_id");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_created_at_idx" ON "ledger_entries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_status_idx" ON "ledger_entries"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_tenant_id_reference_id_entry_type_key" ON "ledger_entries"("tenant_id", "reference_id", "entry_type");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_status_idx" ON "invoices"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_customer_phone_idx" ON "invoices"("tenant_id", "customer_phone");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_upload_batch_id_idx" ON "invoices"("tenant_id", "upload_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_number_key" ON "invoices"("tenant_id", "invoice_number");

-- CreateIndex
CREATE INDEX "redemption_tokens_tenant_id_status_idx" ON "redemption_tokens"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "redemption_tokens_consumer_account_id_idx" ON "redemption_tokens"("consumer_account_id");

-- CreateIndex
CREATE INDEX "redemption_tokens_token_signature_idx" ON "redemption_tokens"("token_signature");

-- CreateIndex
CREATE INDEX "products_tenant_id_active_idx" ON "products"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "products_tenant_id_active_stock_idx" ON "products"("tenant_id", "active", "stock");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tenant_id_email_key" ON "staff"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "disputes_tenant_id_status_idx" ON "disputes"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "disputes_consumer_account_id_idx" ON "disputes"("consumer_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "otp_sessions_phone_number_used_expires_at_idx" ON "otp_sessions"("phone_number", "used", "expires_at");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_asset_config" ADD CONSTRAINT "tenant_asset_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_asset_config" ADD CONSTRAINT "tenant_asset_config_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_paired_entry_id_fkey" FOREIGN KEY ("paired_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_upload_batch_id_fkey" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_uploaded_by_staff_id_fkey" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_used_by_staff_id_fkey" FOREIGN KEY ("used_by_staff_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_tokens" ADD CONSTRAINT "redemption_tokens_ledger_pending_entry_id_fkey" FOREIGN KEY ("ledger_pending_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_ledger_adjustment_entry_id_fkey" FOREIGN KEY ("ledger_adjustment_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- CUSTOM: Make paired_entry_id FK deferrable for double-entry inserts
-- ============================================================
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_paired_entry_id_fkey";
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_paired_entry_id_fkey"
  FOREIGN KEY ("paired_entry_id") REFERENCES "ledger_entries"("id")
  DEFERRABLE INITIALLY DEFERRED;

-- ============================================================
-- CUSTOM: Immutability triggers on ledger_entries
-- ============================================================
CREATE OR REPLACE FUNCTION reject_ledger_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_ledger_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable — DELETE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_no_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_update();

CREATE TRIGGER trg_ledger_no_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_delete();

-- ============================================================
-- CUSTOM: Immutability triggers on audit_log
-- ============================================================
CREATE OR REPLACE FUNCTION reject_audit_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are immutable — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_audit_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are immutable — DELETE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_update();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_delete();

-- ============================================================
-- CUSTOM: CHECK constraints (Prisma doesn't support these natively)
-- ============================================================
ALTER TABLE "ledger_entries" ADD CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0);
ALTER TABLE "products" ADD CONSTRAINT chk_product_cost_positive CHECK (redemption_cost > 0);
ALTER TABLE "products" ADD CONSTRAINT chk_product_stock_nonneg CHECK (stock >= 0);
