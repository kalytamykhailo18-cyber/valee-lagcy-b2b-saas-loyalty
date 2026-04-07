-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "dual_scan_cap_per_cashier" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "dual_scan_cap_per_consumer" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "dual_scan_ttl_seconds" INTEGER NOT NULL DEFAULT 60;
