-- Audit category for owner-initiated cashier branch reassignment.
-- Counted to enforce the "one edit only" rule — a second PATCH is
-- rejected and the owner is told to contact Valee support.

ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'STAFF_BRANCH_CHANGED';
