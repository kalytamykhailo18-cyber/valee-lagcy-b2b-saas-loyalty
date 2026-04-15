-- AlterTable
ALTER TABLE "recurrence_rules" ADD COLUMN     "target_phones" TEXT[] DEFAULT ARRAY[]::TEXT[];
