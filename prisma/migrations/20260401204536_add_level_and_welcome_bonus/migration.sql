-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — DEFERRABLE INITIALLY DEFERRED (custom)

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "welcome_bonus_granted" BOOLEAN NOT NULL DEFAULT false;
