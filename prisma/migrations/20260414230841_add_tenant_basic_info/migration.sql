-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "address" VARCHAR(500),
ADD COLUMN     "contact_email" VARCHAR(255),
ADD COLUMN     "contact_phone" VARCHAR(30),
ADD COLUMN     "description" VARCHAR(1000),
ADD COLUMN     "instagram_handle" VARCHAR(100),
ADD COLUMN     "website" VARCHAR(500);
