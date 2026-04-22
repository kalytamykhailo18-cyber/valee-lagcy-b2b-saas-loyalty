-- Eric's rule for product cards:
--   * Each card can be edited at most 2 times after creation (only
--     identity fields — name/description/photo/cost — count, so stock
--     and active toggles don't burn the budget).
--   * Stock=0 auto-disables the card and blocks re-enabling until
--     stock returns; an auto-disable flag lets us distinguish owner
--     intent from the stock guard.
--   * Instead of a hard delete, merchants archive a card; archived
--     cards disappear from the catalog but keep their redemption
--     history intact for audits.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_edit_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_auto_disabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS products_tenant_archived_idx
  ON products (tenant_id, archived_at);
