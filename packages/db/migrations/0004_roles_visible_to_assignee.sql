-- 0004 A user can always see the roles assigned to them, even when the active tenant is different or unset.
-- Needed to show "my organizations and roles" before a tenant is selected. Does not expose other users' roles.
DROP POLICY roles_select ON roles;
CREATE POLICY roles_select ON roles FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = app_tenant_id()
    OR app_is_platform()
    OR id IN (SELECT ra.role_id FROM role_assignments ra WHERE ra.user_id = app_user_id())
  );
