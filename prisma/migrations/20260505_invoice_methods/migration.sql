-- Eric 2026-05-05 (Notion "F (genesis) Configuracion de texto"):
-- Per-tenant multi-select of which billing methods they use. Drives the
-- welcome modal copy on the consumer PWA so the greeting matches what
-- the merchant actually accepts.
ALTER TABLE tenants
  ADD COLUMN invoice_methods text[] NOT NULL DEFAULT ARRAY['fiscal_invoice']::text[];
