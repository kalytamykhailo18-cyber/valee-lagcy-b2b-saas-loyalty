-- No-op: paired_entry_id FK is managed as DEFERRABLE INITIALLY DEFERRED in the init migration.
-- Prisma schema no longer declares the relation to prevent drift detection from
-- replacing our custom deferrable FK with a standard one.
-- The FK constraint ledger_entries_paired_entry_id_fkey remains in the database unchanged.
SELECT 1;
