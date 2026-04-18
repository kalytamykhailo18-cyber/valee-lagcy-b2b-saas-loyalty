-- Add staff QR attribution columns
ALTER TABLE "staff"
  ADD COLUMN "qr_slug" VARCHAR(16),
  ADD COLUMN "qr_code_url" TEXT,
  ADD COLUMN "qr_generated_at" TIMESTAMPTZ;

-- Unique index on qr_slug (nullable)
CREATE UNIQUE INDEX "staff_qr_slug_key" ON "staff"("qr_slug");
