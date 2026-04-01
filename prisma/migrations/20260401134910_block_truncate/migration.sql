-- Block TRUNCATE on immutable tables (ledger_entries and audit_log)
-- Row-level triggers prevent UPDATE and DELETE, but TRUNCATE bypasses them.
-- Statement-level BEFORE TRUNCATE triggers close this gap.

-- Skip: do NOT touch paired_entry_id FK — it must stay DEFERRABLE INITIALLY DEFERRED

CREATE OR REPLACE FUNCTION reject_ledger_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable — TRUNCATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ledger_no_truncate') THEN
    CREATE TRIGGER trg_ledger_no_truncate
      BEFORE TRUNCATE ON "ledger_entries"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_truncate();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_audit_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are immutable — TRUNCATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_no_truncate') THEN
    CREATE TRIGGER trg_audit_no_truncate
      BEFORE TRUNCATE ON "audit_log"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();
  END IF;
END $$;
