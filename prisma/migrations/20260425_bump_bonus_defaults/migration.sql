-- Bump welcome / referral bonus column defaults so newly-created tenants
-- start at 5000 / 1000 instead of 50 / 100 (Eric 2026-04-25).
ALTER TABLE tenants
  ALTER COLUMN welcome_bonus_amount SET DEFAULT 5000,
  ALTER COLUMN referral_bonus_amount SET DEFAULT 1000;
