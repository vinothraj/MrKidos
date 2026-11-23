-- 0001 Foundation: tenancy, identity skeleton, RBAC, audit, and row-level security.
--
-- Tenant isolation model (see docs/ARCHITECTURE.md section 4):
--   * The app connects as `kidos_app` (NOSUPERUSER, NOBYPASSRLS, owns nothing).
--   * Each request runs in a transaction that sets, with SET LOCAL semantics:
--       app.tenant_id       active organization (uuid)
--       app.user_id         authenticated user (uuid)
--       app.platform_scope  'on' to request platform-wide access
--   * Platform-wide access additionally requires a row in platform_staff for the user.
--     The setting alone grants nothing.
--   * RLS is the tenant boundary only. Fine-grained permissions are enforced in the application (RBAC).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kidos_app') THEN
    CREATE ROLE kidos_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Users allowed to request platform-wide scope. Self-visible only; written by migrations/ops tooling, not by the app role.
CREATE TABLE platform_staff (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_scope', true), '') = 'on'
     AND EXISTS (SELECT 1 FROM platform_staff ps WHERE ps.user_id = app_user_id())
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('platform', 'community', 'vendor')),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  parent_id   uuid REFERENCES organizations (id),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verification', 'active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_type_idx ON organizations (type);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- First tenant-owned domain table, proving the pattern. Detailed fields arrive in Phase 3.
CREATE TABLE community_profiles (
  tenant_id   uuid PRIMARY KEY REFERENCES organizations (id),
  city        text,
  locality    text,
  unit_count  integer CHECK (unit_count IS NULL OR unit_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER community_profiles_updated_at BEFORE UPDATE ON community_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- RBAC (permissions are global reference data; roles may be system-wide or tenant-defined)
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description  text NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES organizations (id),        -- NULL = system role available to all tenants
  scope_type  text NOT NULL CHECK (scope_type IN ('platform', 'community', 'vendor', 'user')),
  key         text NOT NULL CHECK (key ~ '^[a-z_]+$'),
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_system OR tenant_id IS NULL)
);
CREATE UNIQUE INDEX roles_system_key_unique ON roles (key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX roles_tenant_key_unique ON roles (tenant_id, key) WHERE tenant_id IS NOT NULL;
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id          uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions (code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE role_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  role_id     uuid NOT NULL REFERENCES roles (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role_id)
);
CREATE INDEX role_assignments_user_idx ON role_assignments (user_id);

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES organizations (id),      -- NULL = platform-level event
  actor_user_id  uuid REFERENCES users (id),
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Row-level security. ENABLE + FORCE so even a table owner is subject to policies.
-- ---------------------------------------------------------------------------
ALTER TABLE users              ENABLE ROW LEVEL SECURITY; ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_staff     ENABLE ROW LEVEL SECURITY; ALTER TABLE platform_staff     FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations      ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations      FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships        ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships        FORCE ROW LEVEL SECURITY;
ALTER TABLE community_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE community_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE roles              ENABLE ROW LEVEL SECURITY; ALTER TABLE roles              FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions   ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permissions   FORCE ROW LEVEL SECURITY;
ALTER TABLE role_assignments   ENABLE ROW LEVEL SECURITY; ALTER TABLE role_assignments   FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log          FORCE ROW LEVEL SECURITY;

-- platform_staff: a user can see only their own row. No write policy: the app role cannot modify it.
CREATE POLICY platform_staff_select ON platform_staff FOR SELECT USING (user_id = app_user_id());

-- memberships (defined before users/organizations policies that reference it)
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id() OR app_is_platform());
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (tenant_id = app_tenant_id() OR app_is_platform());

-- users: self, members of the active tenant, or platform scope. Insert requires the context user to equal the new id.
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_user_id()
    OR app_is_platform()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id())
  );
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (id = app_user_id() OR app_is_platform());
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_user_id() OR app_is_platform())
  WITH CHECK (id = app_user_id() OR app_is_platform());

-- organizations: the active tenant, tenants the user belongs to, or platform scope. Only platform staff create them.
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (
    id = app_tenant_id()
    OR app_is_platform()
    OR id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_user_id())
  );
CREATE POLICY organizations_insert ON organizations FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = app_tenant_id() OR app_is_platform())
  WITH CHECK (id = app_tenant_id() OR app_is_platform());

-- community_profiles
CREATE POLICY community_profiles_all ON community_profiles FOR ALL
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());

-- roles: system roles (tenant_id NULL) readable by all; tenant roles by that tenant; system roles writable by platform only.
CREATE POLICY roles_select ON roles FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY roles_insert ON roles FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND NOT is_system));
CREATE POLICY roles_update ON roles FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND NOT is_system))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND NOT is_system));
CREATE POLICY roles_delete ON roles FOR DELETE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND NOT is_system));

-- role_permissions follows the visibility and write rules of the owning role.
CREATE POLICY role_permissions_select ON role_permissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id));
CREATE POLICY role_permissions_insert ON role_permissions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
      AND (app_is_platform() OR (r.tenant_id = app_tenant_id() AND NOT r.is_system))));
CREATE POLICY role_permissions_delete ON role_permissions FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
      AND (app_is_platform() OR (r.tenant_id = app_tenant_id() AND NOT r.is_system))));

-- role_assignments: active tenant, or the user's own assignments (needed to list their tenants and roles).
CREATE POLICY role_assignments_select ON role_assignments FOR SELECT
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id() OR app_is_platform());
CREATE POLICY role_assignments_insert ON role_assignments FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY role_assignments_delete ON role_assignments FOR DELETE
  USING (tenant_id = app_tenant_id() OR app_is_platform());

-- audit_log: tenant members of the active tenant (permission-gated in the app) or platform scope read; anyone in context may append.
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant_id() OR app_is_platform());

-- ---------------------------------------------------------------------------
-- Grants: least privilege for the application role.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO kidos_app;
GRANT SELECT, INSERT, UPDATE         ON users              TO kidos_app;
GRANT SELECT                         ON platform_staff     TO kidos_app;
GRANT SELECT, INSERT, UPDATE         ON organizations      TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships        TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_profiles TO kidos_app;
GRANT SELECT                         ON permissions        TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON roles              TO kidos_app;
GRANT SELECT, INSERT, DELETE         ON role_permissions   TO kidos_app;
GRANT SELECT, INSERT, DELETE         ON role_assignments   TO kidos_app;
GRANT SELECT, INSERT                 ON audit_log          TO kidos_app;
GRANT EXECUTE ON FUNCTION app_tenant_id(), app_user_id(), app_is_platform() TO kidos_app;
