-- Audit category for admin-initiated force-logout (bumps the subject's
-- tokens_invalidated_at so any existing token stops working immediately).

ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'SESSION_TERMINATED';
