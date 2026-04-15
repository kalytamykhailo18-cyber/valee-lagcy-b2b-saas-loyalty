-- AlterTable
ALTER TABLE "redemption_tokens" ADD COLUMN     "short_code" VARCHAR(6);

-- CreateIndex
CREATE INDEX "redemption_tokens_tenant_id_short_code_idx" ON "redemption_tokens"("tenant_id", "short_code");
