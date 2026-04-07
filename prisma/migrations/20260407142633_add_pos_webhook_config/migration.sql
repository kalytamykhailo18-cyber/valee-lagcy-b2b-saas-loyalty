-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceSource" ADD VALUE 'pos_webhook';
ALTER TYPE "InvoiceSource" ADD VALUE 'fudo_webhook';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "fudo_api_key" TEXT,
ADD COLUMN     "fudo_webhook_secret" TEXT,
ADD COLUMN     "pos_webhook_secret" TEXT;
