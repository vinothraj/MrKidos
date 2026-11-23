-- 0009 Least-privilege reads, and platform-only internal notes.
--
-- Until now any MEMBER of a community could, at the database level, read the community's membership list, every
-- member's name and email, everyone's roles, the community's private contact details, status history, invite code
-- list and audit trail; only the API's permission checks stopped them. A single forgotten permission check on a future
-- route would have leaked residents' data, so the database now enforces who may READ these as well.
--
-- Mechanism: the API puts the caller's verified permissions in the request context (app.permissions), the same way it
-- already supplies the tenant. A context built without permissions (for example the join flows, whose person is not
-- yet a member) therefore gets the least access by default.

CREATE FUNCTION app_ctx_has_any_permission(p text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.permissions', true), ''), ',') && p, false)
$$;
GRANT EXECUTE ON FUNCTION app_ctx_has_any_permission(text[]) TO kidos_app;

-- ---------------------------------------------------------------------------
-- Internal notes written by the platform team about a community: platform only.
-- (They were a column of community_private, which the community's own administrators can read.)
-- ---------------------------------------------------------------------------
CREATE TABLE community_internal_notes (
  tenant_id   uuid PRIMARY KEY REFERENCES organizations (id),
  notes       text NOT NULL CHECK (length(notes) <= 2000),
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO community_internal_notes (tenant_id, notes)
  SELECT tenant_id, internal_notes FROM community_private WHERE internal_notes IS NOT NULL AND btrim(internal_notes) <> '';
ALTER TABLE community_private DROP COLUMN internal_notes;
ALTER TABLE community_internal_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE community_internal_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY community_internal_notes_platform ON community_internal_notes FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT ON community_internal_notes TO kidos_app;
GRANT UPDATE (notes, updated_by, updated_at) ON community_internal_notes TO kidos_app;

-- ---------------------------------------------------------------------------
-- users: you, a person whose email you are looking up to log in, platform staff, or, for staff who manage people,
-- the people in the community you are acting in. Ordinary members can no longer see their neighbours.
-- ---------------------------------------------------------------------------
DROP POLICY users_select ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_user_id()
    OR lower(email) = app_login_email()
    OR app_is_platform()
    OR (
      app_ctx_has_any_permission(ARRAY['memberships.approve', 'communities.read', 'users.manage', 'vendor_staff.manage'])
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id())
    )
  );

-- ---------------------------------------------------------------------------
-- memberships and role_assignments: your own rows, or the community's rows for staff who manage people.
-- ---------------------------------------------------------------------------
DROP POLICY memberships_select ON memberships;
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (
    user_id = app_user_id()
    OR app_is_platform()
    OR (tenant_id = app_tenant_id()
        AND app_ctx_has_any_permission(ARRAY['memberships.approve', 'communities.read', 'roles.manage', 'users.manage', 'vendor_staff.manage']))
  );

DROP POLICY role_assignments_select ON role_assignments;
CREATE POLICY role_assignments_select ON role_assignments FOR SELECT
  USING (
    user_id = app_user_id()
    OR app_is_platform()
    OR (tenant_id = app_tenant_id()
        AND app_ctx_has_any_permission(ARRAY['memberships.approve', 'communities.read', 'roles.manage', 'users.manage', 'vendor_staff.manage']))
  );

-- ---------------------------------------------------------------------------
-- audit trail, community private details, status history, invite code list
-- ---------------------------------------------------------------------------
DROP POLICY audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['audit.read'])));

DROP POLICY community_private_all ON community_private;
CREATE POLICY community_private_select ON community_private FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.read'])));
CREATE POLICY community_private_insert ON community_private FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('communities.update')));
CREATE POLICY community_private_update ON community_private FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('communities.update')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('communities.update')));

DROP POLICY community_status_history_select ON community_status_history;
CREATE POLICY community_status_history_select ON community_status_history FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.read'])));

DROP POLICY invite_codes_select ON invite_codes;
CREATE POLICY invite_codes_select ON invite_codes FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['memberships.approve']))
    OR code_hash = app_token_hash()
  );
