-- Per-subject logout marker: every JWT we issue carries an iat claim.
-- Tokens with iat <= accounts.tokens_invalidated_at (or staff.tokens_invalidated_at)
-- are rejected at auth-check time, letting us force-logout a specific subject
-- without rotating the global JWT secret or maintaining a jti blocklist.

ALTER TABLE accounts ADD COLUMN tokens_invalidated_at TIMESTAMPTZ;
ALTER TABLE staff    ADD COLUMN tokens_invalidated_at TIMESTAMPTZ;
