-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_paired_entry_id_fkey";

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "rif" VARCHAR(50),
ADD COLUMN     "welcome_bonus_amount" INTEGER NOT NULL DEFAULT 50;
