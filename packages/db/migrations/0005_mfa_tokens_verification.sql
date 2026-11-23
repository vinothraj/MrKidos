-- 0005 MFA (TOTP + recovery codes), one-time tokens (email verification, password reset),
-- role-driven MFA requirement, and a hardening of column-level grants on users.

-- ---------------------------------------------------------------------------
-- Hardening: the application role may no longer rewrite arbitrary user columns.
-- (Email changes, status changes and similar will get dedicated, audited flows.)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
REVOKE UPDATE ON users FROM kidos_app;
GRANT UPDATE (display_name, email_verified_at, deleted_at) ON users TO kidos_app;

-- ---------------------------------------------------------------------------
-- Role-driven MFA requirement (configurable data, not hardcoded role names in code)
-- ---------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN requires_mfa boolean NOT NULL DEFAULT false;
UPDATE roles SET requires_mfa = true
 WHERE tenant_id IS NULL
   AND key IN ('super_admin', 'platform_admin', 'business_operations', 'vendor_manager', 'customer_support',
               'finance', 'marketing', 'analytics', 'community_admin', 'community_manager', 'community_staff');

-- A session created by password login for a user with MFA stays "pending" until the second factor is verified.
ALTER TABLE sessions ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Token lookup helper for pre-authentication flows (email verification, password reset)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_token_hash() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.token_hash', true), '')
$$;
GRANT EXECUTE ON FUNCTION app_token_hash() TO kidos_app;

CREATE TABLE one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  purpose     text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX one_time_tokens_user_purpose_idx ON one_time_tokens (user_id, purpose) WHERE used_at IS NULL;
ALTER TABLE one_time_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE one_time_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY one_time_tokens_select ON one_time_tokens FOR SELECT
  USING (user_id = app_user_id() OR token_hash = app_token_hash());
CREATE POLICY one_time_tokens_insert ON one_time_tokens FOR INSERT
  WITH CHECK (user_id = app_user_id());
CREATE POLICY one_time_tokens_update ON one_time_tokens FOR UPDATE
  USING (user_id = app_user_id() OR token_hash = app_token_hash())
  WITH CHECK (user_id = app_user_id() OR token_hash = app_token_hash());
GRANT SELECT, INSERT ON one_time_tokens TO kidos_app;
GRANT UPDATE (used_at) ON one_time_tokens TO kidos_app;

-- ---------------------------------------------------------------------------
-- MFA
-- ---------------------------------------------------------------------------
CREATE TABLE mfa_credentials (
  user_id            uuid PRIMARY KEY REFERENCES users (id),
  secret_encrypted   text NOT NULL,                -- AES-256-GCM, bound to the user id; never stored in plaintext
  confirmed_at       timestamptz,                  -- NULL while enrollment is unconfirmed
  last_used_step     bigint NOT NULL DEFAULT 0,    -- TOTP time step last accepted (replay protection)
  failed_attempts    integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mfa_credentials_updated_at BEFORE UPDATE ON mfa_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE mfa_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY mfa_credentials_all ON mfa_credentials FOR ALL
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, DELETE ON mfa_credentials TO kidos_app;
GRANT UPDATE (confirmed_at, last_used_step, failed_attempts, locked_until) ON mfa_credentials TO kidos_app;

CREATE TABLE mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY mfa_recovery_codes_all ON mfa_recovery_codes FOR ALL
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, DELETE ON mfa_recovery_codes TO kidos_app;
GRANT UPDATE (used_at) ON mfa_recovery_codes TO kidos_app;
