-- Multi-sucursal product scope via join table. Empty join === tenant-wide.
-- Backfilled from existing products.branch_id so single-sucursal products
-- keep working identically (one assignment row each).
CREATE TABLE "product_branches" (
  "product_id" UUID NOT NULL,
  "branch_id"  UUID NOT NULL,
  CONSTRAINT "product_branches_pkey" PRIMARY KEY ("product_id", "branch_id"),
  CONSTRAINT "product_branches_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
  CONSTRAINT "product_branches_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE
);

CREATE INDEX "product_branches_branch_id_idx" ON "product_branches" ("branch_id");

INSERT INTO "product_branches" ("product_id", "branch_id")
  SELECT id, branch_id FROM "products" WHERE branch_id IS NOT NULL
  ON CONFLICT DO NOTHING;
