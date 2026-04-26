-- Add ON/OFF toggle and stock cap for welcome and referral bonuses (Eric 2026-04-25).
ALTER TABLE tenants
  ADD COLUMN welcome_bonus_active boolean NOT NULL DEFAULT true,
  ADD COLUMN welcome_bonus_limit integer,
  ADD COLUMN referral_bonus_active boolean NOT NULL DEFAULT true,
  ADD COLUMN referral_bonus_limit integer;
