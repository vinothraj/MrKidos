-- 0011 Vetting must stay current, and vendor owners need two-step verification.
--
-- Found in the Phase 4 review: a vendor is vetted once, at activation. Nothing noticed when a required document expired
-- afterwards, so a vendor whose background check or safety briefing had lapsed stayed visible to families.
--
-- Fix: the catalog fails closed. A vendor is shown to residents only while every REQUIRED vetting requirement has a
-- verified document that has not expired. Expiry needs no scheduled job: the policy compares a stored date with today.
--
-- Residents cannot read the documents (and must not), so the decision is kept in a small summary row per vendor that
-- the catalog policy can read. Only the platform team writes it, and a trigger keeps it in step with the documents, so
-- no code path can forget to update it.

CREATE TABLE vendor_vetting_summary (
  tenant_id   uuid PRIMARY KEY REFERENCES organizations (id),
  -- every required requirement has at least one verified document
  complete    boolean NOT NULL DEFAULT false,
  -- the earliest expiry among the documents that currently satisfy the requirements; NULL = none of them expires
  valid_until date,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vendor_vetting_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_vetting_summary FORCE ROW LEVEL SECURITY;

-- Readable by the platform, by the vendor's own context, and by a community the vendor serves (needed by the catalog
-- policy below; the row holds only a flag and a date). Written only by the platform team.
CREATE POLICY vendor_vetting_summary_select ON vendor_vetting_summary FOR SELECT
  USING (
    app_is_platform()
    OR tenant_id = app_tenant_id()
    OR EXISTS (SELECT 1 FROM vendor_service_areas sa WHERE sa.tenant_id = vendor_vetting_summary.tenant_id AND sa.community_id = app_tenant_id())
  );
CREATE POLICY vendor_vetting_summary_write ON vendor_vetting_summary FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT ON vendor_vetting_summary TO kidos_app;
GRANT UPDATE (complete, valid_until, updated_at) ON vendor_vetting_summary TO kidos_app;

-- Recomputes one vendor's summary from its documents.
CREATE FUNCTION refresh_vendor_vetting(p_vendor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_complete boolean;
  v_until    date;
BEGIN
  WITH per_requirement AS (
    SELECT (SELECT max(COALESCE(d.expires_on, 'infinity'::date))
              FROM vendor_documents d
             WHERE d.tenant_id = p_vendor AND d.requirement_key = r.key AND d.status = 'verified') AS best
      FROM vetting_requirements r
     WHERE r.is_required
  )
  SELECT COALESCE(bool_and(best IS NOT NULL), true), min(best) INTO v_complete, v_until FROM per_requirement;
  IF v_until = 'infinity'::date THEN v_until := NULL; END IF;
  INSERT INTO vendor_vetting_summary (tenant_id, complete, valid_until) VALUES (p_vendor, v_complete, v_until)
  ON CONFLICT (tenant_id) DO UPDATE SET complete = EXCLUDED.complete, valid_until = EXCLUDED.valid_until, updated_at = now();
END
$$;
GRANT EXECUTE ON FUNCTION refresh_vendor_vetting(uuid) TO kidos_app;

-- Only a verified document can change the outcome, and only the platform team can verify, so a vendor submitting or
-- withdrawing its own (unreviewed) documents never needs to write the summary.
CREATE FUNCTION vendor_documents_refresh_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.status = 'verified' THEN
    PERFORM refresh_vendor_vetting(NEW.tenant_id);
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.status = 'verified' THEN
    PERFORM refresh_vendor_vetting(OLD.tenant_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER vendor_documents_refresh_summary AFTER INSERT OR UPDATE OR DELETE ON vendor_documents
  FOR EACH ROW EXECUTE FUNCTION vendor_documents_refresh_summary();

-- Existing vendors (development databases): compute their summary now. (Runs as the migration owner.)
SELECT refresh_vendor_vetting(id) FROM organizations WHERE type = 'vendor';

-- The catalog policy, now also requiring current vetting. Everything else is exactly as in 0010.
DROP POLICY organizations_vendor_catalog ON organizations;
CREATE POLICY organizations_vendor_catalog ON organizations FOR SELECT
  USING (
    type = 'vendor' AND status = 'active' AND app_user_id() IS NOT NULL
    -- the person is an active member of the community they are acting in
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app_tenant_id() AND m.user_id = app_user_id() AND m.status = 'active')
    -- the vendor serves that community
    AND EXISTS (SELECT 1 FROM vendor_service_areas sa WHERE sa.tenant_id = organizations.id AND sa.community_id = app_tenant_id())
    -- its required documents are all verified and none has expired (fails closed: no summary row means not shown)
    AND EXISTS (SELECT 1 FROM vendor_vetting_summary s WHERE s.tenant_id = organizations.id AND s.complete AND (s.valid_until IS NULL OR s.valid_until >= current_date))
    -- and, unless the community turned the policy off, the community has approved it
    AND (
      NOT COALESCE((SELECT p.value = 'true'::jsonb FROM community_policies p WHERE p.tenant_id = app_tenant_id() AND p.key = 'vendor_approval_required'), true)
      OR EXISTS (SELECT 1 FROM community_vendor_approvals a WHERE a.tenant_id = app_tenant_id() AND a.vendor_id = organizations.id AND a.status = 'approved')
    )
  );

-- Vendors handle documents about people and, later, children's activities: their owners and administrators now
-- need two-step verification, like platform and community staff. (A data change: reverse it here if the founder decides otherwise.)
UPDATE roles SET requires_mfa = true WHERE tenant_id IS NULL AND key IN ('vendor_owner', 'vendor_admin');
