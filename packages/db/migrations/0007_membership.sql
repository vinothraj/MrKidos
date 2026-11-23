-- 0007 Membership: invite codes, and database-enforced rules for who may create, approve and change memberships
-- and member roles. Until now these writes were guarded only by application code; joining a community is the first
-- flow where the person acting is NOT yet a member, so the rules move into row-level security as well.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Does the current user hold `p` in the current tenant (through role assignments)?
CREATE FUNCTION app_has_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_assignments ra
      JOIN role_permissions rp ON rp.role_id = ra.role_id
     WHERE ra.user_id = app_user_id() AND ra.tenant_id = app_tenant_id() AND rp.permission_code = p)
$$;

-- Roles a resident household may hold. Admin-level roles are never grantable through membership flows.
CREATE FUNCTION app_is_member_role(role_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id IS NULL AND r.key IN ('resident', 'parent_guardian', 'family_member'))
$$;

-- Is the community in the current tenant context active (joinable)?
CREATE FUNCTION app_tenant_is_active_community() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM organizations o WHERE o.id = app_tenant_id() AND o.type = 'community' AND o.status = 'active')
$$;

-- ---------------------------------------------------------------------------
-- Invite codes (only a hash is stored; the code is shown once when created)
-- ---------------------------------------------------------------------------
CREATE TABLE invite_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  code_hash   text NOT NULL UNIQUE,
  code_hint   text NOT NULL CHECK (length(code_hint) = 4),      -- last 4 characters, to recognise a code in a list
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  max_uses    integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
  uses        integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (uses <= max_uses)
);
CREATE INDEX invite_codes_tenant_idx ON invite_codes (tenant_id, created_at DESC);
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE invite_codes FORCE ROW LEVEL SECURITY;

-- Community staff manage their codes; someone presenting a code (token hash in context) can see that one valid code.
CREATE POLICY invite_codes_select ON invite_codes FOR SELECT
  USING (tenant_id = app_tenant_id() OR app_is_platform() OR code_hash = app_token_hash());
CREATE POLICY invite_codes_insert ON invite_codes FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve')));
CREATE POLICY invite_codes_update ON invite_codes FOR UPDATE
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve'))
    OR (code_hash = app_token_hash() AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses)
  )
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve'))
    OR (code_hash = app_token_hash() AND revoked_at IS NULL)
  );
GRANT SELECT, INSERT ON invite_codes TO kidos_app;
GRANT UPDATE (uses, revoked_at) ON invite_codes TO kidos_app;

-- The presenting user's code is valid for the community in context (not revoked, not expired, uses left).
CREATE FUNCTION app_invite_valid() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM invite_codes ic
     WHERE ic.tenant_id = app_tenant_id() AND ic.code_hash = app_token_hash()
       AND ic.revoked_at IS NULL AND (ic.expires_at IS NULL OR ic.expires_at > now()) AND ic.uses < ic.max_uses)
$$;
GRANT EXECUTE ON FUNCTION app_has_permission(text), app_is_member_role(uuid), app_tenant_is_active_community(), app_invite_valid() TO kidos_app;

-- ---------------------------------------------------------------------------
-- memberships: who may create, change and remove rows
-- ---------------------------------------------------------------------------
DROP POLICY memberships_insert ON memberships;
DROP POLICY memberships_update ON memberships;
DROP POLICY memberships_delete ON memberships;

CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
         -- staff adding or approving members
         app_has_permission('memberships.approve')
         -- a person asking to join an ACTIVE community: only their own row, only pending
         OR (user_id = app_user_id() AND status = 'pending' AND join_method = 'admin_approval' AND app_tenant_is_active_community())
         -- a person joining an ACTIVE community with a valid invite code: only their own row
         OR (user_id = app_user_id() AND status = 'active' AND join_method = 'invite_code' AND app_tenant_is_active_community() AND app_invite_valid())
    ))
  );

CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve'))
    OR user_id = app_user_id()
  )
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve'))
    -- a person may only leave or withdraw their own membership, never grant themselves anything
    OR (user_id = app_user_id() AND tenant_id = app_tenant_id() AND status = 'removed')
  );

CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('memberships.approve')));

-- ---------------------------------------------------------------------------
-- role_assignments: members get resident-level roles; admin-level roles need roles.manage or platform scope
-- ---------------------------------------------------------------------------
DROP POLICY role_assignments_insert ON role_assignments;
DROP POLICY role_assignments_delete ON role_assignments;

CREATE POLICY role_assignments_insert ON role_assignments FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
         app_has_permission('roles.manage')
         OR (app_has_permission('memberships.approve') AND app_is_member_role(role_id))
         -- joining: a person receives resident-level roles for a membership of their own that is already active
         OR (user_id = app_user_id() AND app_is_member_role(role_id)
             AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = role_assignments.tenant_id AND m.user_id = app_user_id() AND m.status = 'active'))
    ))
  );

CREATE POLICY role_assignments_delete ON role_assignments FOR DELETE
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (app_has_permission('roles.manage') OR (app_has_permission('memberships.approve') AND app_is_member_role(role_id))))
  );
