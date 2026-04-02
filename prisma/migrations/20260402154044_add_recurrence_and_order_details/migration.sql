-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — DEFERRABLE INITIALLY DEFERRED (custom)

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "order_details" JSONB;

-- CreateTable
CREATE TABLE "recurrence_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "grace_days" INTEGER NOT NULL DEFAULT 1,
    "message_template" TEXT NOT NULL,
    "bonus_amount" DECIMAL(18,8),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "consumer_account_id" UUID NOT NULL,
    "last_visit_at" TIMESTAMPTZ NOT NULL,
    "days_since_visit" INTEGER NOT NULL,
    "message_sent" TEXT NOT NULL,
    "bonus_granted" BOOLEAN NOT NULL DEFAULT false,
    "ledger_entry_id" UUID,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurrence_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurrence_rules_tenant_id_active_idx" ON "recurrence_rules"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "recurrence_notifications_tenant_id_consumer_account_id_idx" ON "recurrence_notifications"("tenant_id", "consumer_account_id");

-- CreateIndex
CREATE INDEX "recurrence_notifications_tenant_id_sent_at_idx" ON "recurrence_notifications"("tenant_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_notifications_tenant_id_rule_id_consumer_account_key" ON "recurrence_notifications"("tenant_id", "rule_id", "consumer_account_id", "last_visit_at");

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_notifications" ADD CONSTRAINT "recurrence_notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_notifications" ADD CONSTRAINT "recurrence_notifications_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recurrence_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_notifications" ADD CONSTRAINT "recurrence_notifications_consumer_account_id_fkey" FOREIGN KEY ("consumer_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_notifications" ADD CONSTRAINT "recurrence_notifications_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
