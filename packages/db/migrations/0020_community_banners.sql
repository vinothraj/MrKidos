-- 0020 Community banners: short announcements an administrator writes for their community's Home screen
-- ("Diwali celebration this Saturday", "Summer camps open"), with a picture from the approved set and optional dates.
--
-- Who sees what (row-level security, not the API, decides):
--   members acting in the community: only banners that are switched on and inside their dates;
--   administrators with communities.update there, and platform scope: every banner of that community;
--   nobody else: nothing.
-- Pictures are names of approved photo slots (never an uploaded file or an outside address), and a banner's link can
-- only point inside the signed-in app, so a banner cannot be used to send residents to a look-alike site.

CREATE TABLE community_banners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  message     text NOT NULL DEFAULT '' CHECK (length(message) <= 280),
  picture     text NOT NULL DEFAULT 'celebrate' CHECK (picture IN ('none', 'family', 'community', 'celebrate', 'kids', 'explore')),
  link_path   text CHECK (link_path IS NULL OR link_path ~ '^/app(/[A-Za-z0-9_-]+)*/?$'),
  link_label  text CHECK (link_label IS NULL OR length(btrim(link_label)) BETWEEN 1 AND 40),
  starts_on   date,
  ends_on     date,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users (id),
  updated_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK ((link_path IS NULL) = (link_label IS NULL))
);
CREATE INDEX community_banners_tenant_idx ON community_banners (tenant_id, created_at DESC);

ALTER TABLE community_banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_banners FORCE ROW LEVEL SECURITY;

CREATE POLICY community_banners_select ON community_banners FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
      app_ctx_has_any_permission(ARRAY['communities.update'])
      OR (active AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date))
    ))
  );
CREATE POLICY community_banners_insert ON community_banners FOR INSERT
  WITH CHECK ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform());
CREATE POLICY community_banners_update ON community_banners FOR UPDATE
  USING ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform());
CREATE POLICY community_banners_delete ON community_banners FOR DELETE
  USING ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform());

GRANT SELECT, INSERT, DELETE ON community_banners TO kidos_app;
GRANT UPDATE (title, message, picture, link_path, link_label, starts_on, ends_on, active, updated_by, updated_at) ON community_banners TO kidos_app;

-- At most 20 banners per community (a backstop; the API says so first).
CREATE FUNCTION community_banners_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM community_banners b WHERE b.tenant_id = NEW.tenant_id) >= 20 THEN
    RAISE EXCEPTION 'too many banners' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER community_banners_a_limit BEFORE INSERT ON community_banners FOR EACH ROW EXECUTE FUNCTION community_banners_limit();
