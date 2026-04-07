-- CreateEnum
CREATE TYPE "RevenueSource" AS ENUM ('redemption_fee', 'attributed_sale_fee', 'attributed_customer_fee');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "attributed_customer_fixed_fee" DECIMAL(10,2),
ADD COLUMN     "attributed_sale_fee_percent" DECIMAL(5,2),
ADD COLUMN     "redemption_fee_percent" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "platform_revenue" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" "RevenueSource" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "currency" "ReferenceCurrency" NOT NULL,
    "base_amount" DECIMAL(18,8),
    "fee_percent" DECIMAL(5,2),
    "ledger_entry_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_revenue_tenant_id_created_at_idx" ON "platform_revenue"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_revenue_tenant_id_source_idx" ON "platform_revenue"("tenant_id", "source");
