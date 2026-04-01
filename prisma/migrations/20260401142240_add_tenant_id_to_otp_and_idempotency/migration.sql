-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — it is DEFERRABLE INITIALLY DEFERRED (custom)

-- AlterTable
ALTER TABLE "idempotency_keys" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "otp_sessions" ADD COLUMN     "tenant_id" UUID;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_sessions" ADD CONSTRAINT "otp_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
