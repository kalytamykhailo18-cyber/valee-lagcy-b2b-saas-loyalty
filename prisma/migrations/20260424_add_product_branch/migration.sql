-- Per-branch product scope. NULL = tenant-wide (visible from every branch).
ALTER TABLE "products"
  ADD COLUMN "branch_id" UUID NULL,
  ADD CONSTRAINT "products_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;

CREATE INDEX "products_tenant_branch_active_idx"
  ON "products" ("tenant_id", "branch_id", "active");
