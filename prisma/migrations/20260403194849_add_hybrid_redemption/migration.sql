-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — DEFERRABLE INITIALLY DEFERRED (custom)

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "cash_price" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "redemption_tokens" ADD COLUMN     "cash_amount" DECIMAL(18,2);
