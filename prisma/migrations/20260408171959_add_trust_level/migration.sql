-- CreateEnum
CREATE TYPE "TrustLevel" AS ENUM ('level_1_strict', 'level_2_standard', 'level_3_presence');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "trust_level" "TrustLevel" NOT NULL DEFAULT 'level_2_standard';
