-- NOTE: Do NOT drop ledger_entries_paired_entry_id_fkey — it is DEFERRABLE INITIALLY DEFERRED (custom)

-- ============================================================
-- ROW-LEVEL SECURITY: Structural tenant isolation at the data layer.
-- The spec requires: "Queries executed in the context of one tenant must
-- structurally be incapable of returning data belonging to another tenant."
-- ============================================================

-- Create a tenant-context role for the application to use
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loyalty_tenant') THEN
    CREATE ROLE loyalty_tenant NOLOGIN;
  END IF;
END $$;

-- Grant usage to the tenant role
GRANT USAGE ON SCHEMA public TO loyalty_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO loyalty_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO loyalty_tenant;

-- Grant the tenant role to loyalty_admin so the app can SET ROLE
GRANT loyalty_tenant TO loyalty_admin;

-- ============================================================
-- Enable RLS on all tenant-scoped tables
-- ============================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE redemption_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_asset_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_sessions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Policies for loyalty_admin (the app's DB user) — full access (owner bypass)
-- RLS does NOT apply to table owners by default. Since loyalty_admin owns
-- all tables, RLS is already bypassed for loyalty_admin.
-- We need RLS to apply to the loyalty_tenant role.
-- ============================================================

-- FORCE RLS even for the table owner when using SET ROLE loyalty_tenant
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE upload_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE redemption_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_asset_config FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE otp_sessions FORCE ROW LEVEL SECURITY;

-- ============================================================
-- Tenant isolation policies: only see rows matching app.current_tenant_id
-- These apply when the session has SET ROLE loyalty_tenant
-- ============================================================

CREATE POLICY tenant_isolation ON tenants FOR ALL TO loyalty_tenant
  USING (id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON branches FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON accounts FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON ledger_entries FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON invoices FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON upload_batches FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON redemption_tokens FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON products FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON staff FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON audit_log FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true) OR tenant_id IS NULL);

CREATE POLICY tenant_isolation ON disputes FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON tenant_asset_config FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON idempotency_keys FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true) OR tenant_id IS NULL);

CREATE POLICY tenant_isolation ON otp_sessions FOR ALL TO loyalty_tenant
  USING (tenant_id::text = current_setting('app.current_tenant_id', true) OR tenant_id IS NULL);

-- ============================================================
-- Global tables: no RLS needed (asset_types, admin_users)
-- These are accessible to all roles.
-- ============================================================
