-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — DEFERRABLE INITIALLY DEFERRED (custom)

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "min_level" INTEGER NOT NULL DEFAULT 1;
