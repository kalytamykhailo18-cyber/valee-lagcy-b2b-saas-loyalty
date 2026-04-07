-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('basic', 'pro', 'x10');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "plan" "PlanTier" NOT NULL DEFAULT 'basic';
