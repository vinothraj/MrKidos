-- 0003 Authentication: credentials, sessions, the platform organization, and the narrow lookups
-- that must work before a user identity is known (login by email, session by token hash).

-- The one platform organization (tenant type 'platform') with a well-known id.
INSERT INTO organizations (id, type, name, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'platform', 'Platform', 'active');
CREATE UNIQUE INDEX organizations_single_platform ON organizations ((true)) WHERE type = 'platform';

-- Context helpers for pre-authentication lookups.
CREATE FUNCTION app_login_email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(lower(current_setting('app.login_email', true)), '')
$$;
CREATE FUNCTION app_session_hash() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.session_hash', true), '')
$$;

-- A user row is visible when the login lookup names exactly that email (and only that row).
DROP POLICY users_select ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_user_id()
    OR lower(email) = app_login_email()
    OR app_is_platform()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id())
  );

-- Credentials live apart from users so password hashes are readable only once the user id is already established.
CREATE TABLE user_credentials (
  user_id              uuid PRIMARY KEY REFERENCES users (id),
  password_hash        text NOT NULL,
  failed_attempts      integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until         timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_credentials_updated_at BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Server-side sessions. Only a SHA-256 of the opaque cookie token is stored.
CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  token_hash        text NOT NULL UNIQUE,
  active_tenant_id  uuid REFERENCES organizations (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  mfa_verified_at   timestamptz,
  ip                text,
  user_agent        text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY; ALTER TABLE sessions         FORCE ROW LEVEL SECURITY;

CREATE POLICY user_credentials_all ON user_credentials FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

CREATE POLICY sessions_select ON sessions FOR SELECT
  USING (user_id = app_user_id() OR token_hash = app_session_hash());
CREATE POLICY sessions_insert ON sessions FOR INSERT
  WITH CHECK (user_id = app_user_id());
CREATE POLICY sessions_update ON sessions FOR UPDATE
  USING (user_id = app_user_id() OR token_hash = app_session_hash())
  WITH CHECK (user_id = app_user_id() OR token_hash = app_session_hash());

GRANT SELECT, INSERT ON user_credentials TO kidos_app;
GRANT UPDATE (password_hash, failed_attempts, locked_until, password_changed_at, updated_at) ON user_credentials TO kidos_app;
GRANT SELECT, INSERT ON sessions TO kidos_app;
GRANT UPDATE (last_seen_at, active_tenant_id, revoked_at, mfa_verified_at) ON sessions TO kidos_app;
GRANT EXECUTE ON FUNCTION app_login_email(), app_session_hash() TO kidos_app;
