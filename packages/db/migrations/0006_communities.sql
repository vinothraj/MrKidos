-- 0006 Communities: public profile vs private details, facilities, configurable policies, status history,
-- the community directory, membership details, and one new permission.
--
-- Data-protection split:
--   community_profiles  = information safe to show any signed-in user in the directory (name lives on organizations)
--   community_private   = address, GPS, contacts, internal notes: visible only to that community's members and platform staff

-- ---------------------------------------------------------------------------
-- Profile (public part) and private part
-- ---------------------------------------------------------------------------
ALTER TABLE community_profiles
  ADD COLUMN community_type text NOT NULL DEFAULT 'gated_community'
    CHECK (community_type IN ('gated_community', 'apartment_complex', 'township', 'other')),
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 2000),
  ADD COLUMN country text,
  ADD COLUMN state text;

CREATE TABLE community_private (
  tenant_id      uuid PRIMARY KEY REFERENCES organizations (id),
  address        text,
  latitude       numeric(9, 6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude      numeric(9, 6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  population     integer CHECK (population IS NULL OR population >= 0),
  internal_notes text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER community_private_updated_at BEFORE UPDATE ON community_private FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Facilities and venues
-- ---------------------------------------------------------------------------
CREATE TABLE community_facilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations (id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind         text NOT NULL CHECK (kind IN ('clubhouse', 'hall', 'ground', 'court', 'pool', 'garden', 'amphitheatre', 'other')),
  capacity     integer CHECK (capacity IS NULL OR capacity >= 0),
  description  text CHECK (description IS NULL OR length(description) <= 1000),
  bookable     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_facilities_tenant_idx ON community_facilities (tenant_id);
CREATE TRIGGER community_facilities_updated_at BEFORE UPDATE ON community_facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Policies: definitions are reference data (what can be configured), values are per community
-- ---------------------------------------------------------------------------
CREATE TABLE policy_definitions (
  key            text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  label          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  value_type     text NOT NULL CHECK (value_type IN ('boolean', 'text', 'enum')),
  allowed        jsonb,                         -- list of permitted values for enums
  default_value  jsonb NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  CHECK (value_type <> 'enum' OR jsonb_typeof(allowed) = 'array')
);

CREATE TABLE community_policies (
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  key         text NOT NULL REFERENCES policy_definitions (key),
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

INSERT INTO policy_definitions (key, label, description, value_type, allowed, default_value, sort_order) VALUES
  ('resident_join_mode', 'How residents join', 'Admin approval lets residents request to join from the directory. Invite code only means residents need a code you give them.', 'enum', '["admin_approval", "invite_code_only"]', '"admin_approval"', 10),
  ('vendor_approval_required', 'Approve vendors before they serve this community', 'Vendors must be approved by a community administrator before they can be booked here.', 'boolean', NULL, 'true', 20),
  ('event_approval_required', 'Approve events before they are confirmed', 'A community administrator must approve events held in this community.', 'boolean', NULL, 'true', 30),
  ('vendor_entry_requirements', 'Vendor entry requirements', 'What vendors must bring or do to enter the community (ID, vehicle pass, safety briefing).', 'text', NULL, '""', 40),
  ('quiet_hours', 'Quiet hours', 'Times when events and equipment noise are not allowed, for example 22:00-07:00.', 'text', NULL, '""', 50);

-- ---------------------------------------------------------------------------
-- Status history (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE community_status_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations (id),
  from_status  text,
  to_status    text NOT NULL,
  note         text,
  changed_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_status_history_tenant_idx ON community_status_history (tenant_id, created_at DESC);
CREATE TRIGGER community_status_history_no_update BEFORE UPDATE OR DELETE ON community_status_history FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Membership details
-- ---------------------------------------------------------------------------
ALTER TABLE memberships
  ADD COLUMN join_method text CHECK (join_method IS NULL OR join_method IN ('invite_code', 'admin_approval', 'admin_added')),
  ADD COLUMN unit_label text CHECK (unit_label IS NULL OR length(unit_label) <= 60),
  ADD COLUMN request_note text CHECK (request_note IS NULL OR length(request_note) <= 500),
  ADD COLUMN decided_by uuid REFERENCES users (id),
  ADD COLUMN decided_at timestamptz;

-- ---------------------------------------------------------------------------
-- Row-level security for the new tenant-owned tables
-- ---------------------------------------------------------------------------
ALTER TABLE community_private        ENABLE ROW LEVEL SECURITY; ALTER TABLE community_private        FORCE ROW LEVEL SECURITY;
ALTER TABLE community_facilities     ENABLE ROW LEVEL SECURITY; ALTER TABLE community_facilities     FORCE ROW LEVEL SECURITY;
ALTER TABLE community_policies       ENABLE ROW LEVEL SECURITY; ALTER TABLE community_policies       FORCE ROW LEVEL SECURITY;
ALTER TABLE community_status_history ENABLE ROW LEVEL SECURITY; ALTER TABLE community_status_history FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_definitions       ENABLE ROW LEVEL SECURITY; ALTER TABLE policy_definitions       FORCE ROW LEVEL SECURITY;

CREATE POLICY community_private_all ON community_private FOR ALL
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY community_facilities_all ON community_facilities FOR ALL
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY community_policies_all ON community_policies FOR ALL
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY community_status_history_select ON community_status_history FOR SELECT
  USING (tenant_id = app_tenant_id() OR app_is_platform());
CREATE POLICY community_status_history_insert ON community_status_history FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
-- Policy definitions are reference data readable by any signed-in user; only migrations change them.
CREATE POLICY policy_definitions_select ON policy_definitions FOR SELECT USING (app_user_id() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Community directory: any signed-in user can find ACTIVE communities (name and public profile only).
-- community_private is never part of this.
-- ---------------------------------------------------------------------------
CREATE POLICY organizations_directory ON organizations FOR SELECT
  USING (type = 'community' AND status = 'active' AND app_user_id() IS NOT NULL);
CREATE POLICY community_profiles_directory ON community_profiles FOR SELECT
  USING (
    app_user_id() IS NOT NULL
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = community_profiles.tenant_id AND o.type = 'community' AND o.status = 'active')
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON community_private        TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_facilities     TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_policies       TO kidos_app;
GRANT SELECT, INSERT                 ON community_status_history TO kidos_app;
GRANT SELECT                         ON policy_definitions       TO kidos_app;

-- ---------------------------------------------------------------------------
-- Permission to assign community administrators (platform operations only)
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES ('communities.assign_admin', 'Assign and remove community administrators');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'communities.assign_admin' FROM roles r
 WHERE r.tenant_id IS NULL AND r.key IN ('super_admin', 'platform_admin', 'business_operations');
