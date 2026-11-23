-- 0016 Safety and conduct concerns: a reporting channel with a documented response (SECURITY.md section 3).
--
-- Anyone who is signed in to a community or a vendor can tell the platform team about something that worries them: a
-- child's safety, how someone behaved, money, or anything else. The report goes to the platform team ONLY:
--   * the reporter reads their own reports and the outcome the team chose to share (the "resolution");
--   * operations (the `concerns.manage` permission, in platform scope) read and decide on every report;
--   * nobody else can read a report: not the vendor it is about, not a community administrator (who may be the subject),
--     not another family. There is no vendor or community clause in any policy on purpose.
-- What the team found and why it decided as it did belongs in the vendor's platform-only internal notes (vendor_internal_notes).

INSERT INTO permissions (code, description) VALUES
  ('concerns.create', 'Report a safety or conduct concern to the platform team'),
  ('concerns.manage', 'Review and decide on reported concerns');

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'concerns.create' FROM roles r
 WHERE r.tenant_id IS NULL AND r.key IN ('resident', 'parent_guardian', 'family_member', 'community_admin', 'community_manager', 'community_staff',
                                          'vendor_owner', 'vendor_admin', 'vendor_staff', 'vendor_service_provider',
                                          'super_admin'); -- the super administrator holds every permission (a tested invariant); platform staff cannot report as the platform anyway
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'concerns.manage' FROM roles r
 WHERE r.tenant_id IS NULL AND r.key IN ('super_admin', 'platform_admin', 'business_operations', 'customer_support');

CREATE TABLE concerns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations (id),    -- the community or vendor the reporter was acting in
  reporter_id       uuid NOT NULL REFERENCES users (id),
  category          text NOT NULL CHECK (category IN ('child_safety', 'conduct', 'payment', 'other')),
  vendor_id         uuid REFERENCES organizations (id),             -- the vendor it is about, when it is about one
  subject           text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 150),
  details           text NOT NULL CHECK (length(btrim(details)) BETWEEN 1 AND 3000),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  -- what the reporter is told when the team has decided (never internal findings)
  resolution        text CHECK (resolution IS NULL OR length(btrim(resolution)) BETWEEN 1 AND 1000),
  handled_by        uuid REFERENCES users (id),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concerns_queue_idx ON concerns (status, category, created_at);
CREATE INDEX concerns_reporter_idx ON concerns (reporter_id, created_at DESC);
ALTER TABLE concerns ENABLE ROW LEVEL SECURITY;
ALTER TABLE concerns FORCE ROW LEVEL SECURITY;

CREATE POLICY concerns_select ON concerns FOR SELECT
  USING (
    reporter_id = app_user_id()
    OR (app_is_platform() AND app_ctx_has_any_permission(ARRAY['concerns.manage']))
  );

-- Only as yourself, in the organization you are acting in, holding the permission, starting as 'open'. A vendor it is
-- about must be one the reporter can see now (the existence test runs under the reporter's own row-level security, so
-- a vendor id cannot be probed through this policy). Platform staff do not report as platform.
CREATE POLICY concerns_insert ON concerns FOR INSERT
  WITH CHECK (
    NOT app_is_platform() AND tenant_id = app_tenant_id() AND reporter_id = app_user_id()
    AND status = 'open' AND resolution IS NULL AND handled_by IS NULL
    AND app_has_permission('concerns.create')
    AND (vendor_id IS NULL OR EXISTS (SELECT 1 FROM organizations v WHERE v.id = concerns.vendor_id AND v.type = 'vendor'))
  );

CREATE POLICY concerns_update ON concerns FOR UPDATE
  USING (app_is_platform() AND app_ctx_has_any_permission(ARRAY['concerns.manage']))
  WITH CHECK (app_is_platform() AND app_ctx_has_any_permission(ARRAY['concerns.manage']));

GRANT SELECT, INSERT ON concerns TO kidos_app;
GRANT UPDATE (status, resolution, handled_by, status_changed_at) ON concerns TO kidos_app;

-- What a report says never changes; the decision moves forward only, and the reporter is always given an outcome.
CREATE FUNCTION concerns_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a report says cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NOT app_is_platform() OR NOT app_ctx_has_any_permission(ARRAY['concerns.manage']) THEN
    RAISE EXCEPTION 'only the platform team can decide on a report' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('resolved', 'dismissed') THEN
      RAISE EXCEPTION 'a decided report cannot be reopened' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'open' OR (NEW.status = 'reviewing' AND OLD.status <> 'open') THEN
      RAISE EXCEPTION 'a report cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.status IN ('resolved', 'dismissed') AND length(btrim(COALESCE(NEW.resolution, ''))) = 0 THEN
      RAISE EXCEPTION 'tell the reporter what was decided' USING ERRCODE = '23514';
    END IF;
    NEW.handled_by := app_user_id();
    NEW.status_changed_at := now();
  ELSIF NEW.resolution IS DISTINCT FROM OLD.resolution OR NEW.handled_by IS DISTINCT FROM OLD.handled_by OR NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN
    RAISE EXCEPTION 'the outcome is set together with the decision' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('resolved', 'dismissed') AND NEW.resolution IS NOT NULL THEN
    RAISE EXCEPTION 'only a decided report has an outcome' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER concerns_a_enforce BEFORE UPDATE ON concerns FOR EACH ROW EXECUTE FUNCTION concerns_enforce();

-- A person can have at most 10 undecided reports at once (a backstop against flooding the team; the API says so first).
CREATE FUNCTION concerns_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM concerns c WHERE c.reporter_id = NEW.reporter_id AND c.status IN ('open', 'reviewing')) >= 10 THEN
    RAISE EXCEPTION 'too many open reports' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER concerns_a_limit BEFORE INSERT ON concerns FOR EACH ROW EXECUTE FUNCTION concerns_limit();
