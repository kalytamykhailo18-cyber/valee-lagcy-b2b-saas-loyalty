-- CreateEnum
CREATE TYPE "ExchangeSource" AS ENUM ('bcv', 'binance_p2p', 'bybit_p2p', 'promedio', 'euro_bcv');

-- CreateEnum
CREATE TYPE "ReferenceCurrency" AS ENUM ('usd', 'eur', 'bs');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "preferred_exchange_source" "ExchangeSource",
ADD COLUMN     "reference_currency" "ReferenceCurrency" NOT NULL DEFAULT 'usd';

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "source" "ExchangeSource" NOT NULL,
    "currency" "ReferenceCurrency" NOT NULL,
    "rate_bs" DECIMAL(18,4) NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rates_source_currency_fetched_at_idx" ON "exchange_rates"("source", "currency", "fetched_at" DESC);
