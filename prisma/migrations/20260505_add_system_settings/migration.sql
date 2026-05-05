-- System-wide settings the admin can flip at runtime (Eric 2026-05-04).
-- First use case: auth_channel switch (whatsapp | sms) for the consumer
-- OTP login. Generic key/value lets us add future global flags without
-- new migrations.
CREATE TABLE system_settings (
  key         varchar(64) PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

-- Seed the auth channel default so the admin UI has something to read.
INSERT INTO system_settings (key, value)
VALUES ('auth_channel', '"whatsapp"'::jsonb)
ON CONFLICT (key) DO NOTHING;
