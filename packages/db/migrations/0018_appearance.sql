-- 0018 Appearance: a person's theme choice and a community's colour palette, stored as data.
--
-- A person chooses light, dark or "follow my device", and may pick a palette for themselves. A community's
-- administrators (communities.update) choose the palette their members see by default. Palettes are a closed list here
-- AND in the design system (packages/ui/src/styles.css), where each one is contrast-tested in light and dark: the
-- database never stores a colour value, only the name of a tested palette.

CREATE TABLE user_preferences (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  theme_mode  text NOT NULL DEFAULT 'system' CHECK (theme_mode IN ('system', 'light', 'dark')),
  palette     text CHECK (palette IN ('classic', 'ocean', 'forest')),   -- NULL: use the community's palette
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;

-- Your own row only. No platform clause: nobody else needs to read a person's display preferences.
CREATE POLICY user_preferences_select ON user_preferences FOR SELECT USING (user_id = app_user_id());
CREATE POLICY user_preferences_insert ON user_preferences FOR INSERT WITH CHECK (user_id = app_user_id());
CREATE POLICY user_preferences_update ON user_preferences FOR UPDATE
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

GRANT SELECT, INSERT ON user_preferences TO kidos_app;
GRANT UPDATE (theme_mode, palette, updated_at) ON user_preferences TO kidos_app;

CREATE TABLE community_branding (
  tenant_id   uuid PRIMARY KEY REFERENCES organizations (id),
  palette     text NOT NULL DEFAULT 'classic' CHECK (palette IN ('classic', 'ocean', 'forest')),
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE community_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_branding FORCE ROW LEVEL SECURITY;

-- Every member acting in the community may read its palette (it is applied to their screens); a palette name is not
-- personal or sensitive data.
CREATE POLICY community_branding_select ON community_branding FOR SELECT
  USING (tenant_id = app_tenant_id() OR app_is_platform());
-- Changing it needs communities.update in that community, or platform scope.
CREATE POLICY community_branding_insert ON community_branding FOR INSERT
  WITH CHECK ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform());
CREATE POLICY community_branding_update ON community_branding FOR UPDATE
  USING ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['communities.update'])) OR app_is_platform());

GRANT SELECT, INSERT ON community_branding TO kidos_app;
GRANT UPDATE (palette, updated_by, updated_at) ON community_branding TO kidos_app;
