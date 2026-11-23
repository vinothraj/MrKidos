-- 0008 Family profiles. Children are profiles managed by a guardian, never accounts.
--
-- Privacy by design:
--   * Only the owning guardian can read or change these rows. There is deliberately NO platform-staff or community policy:
--     support and community administrators cannot see children.
--   * Minimal fields only: a nickname, a birth year and interest tags. No photo, school, address or contact data.
--   * Consent is recorded with a version, and can be withdrawn. Erasure is a hard delete.

CREATE TABLE interest_options (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0
);
ALTER TABLE interest_options ENABLE ROW LEVEL SECURITY; ALTER TABLE interest_options FORCE ROW LEVEL SECURITY;
CREATE POLICY interest_options_select ON interest_options FOR SELECT USING (app_user_id() IS NOT NULL);
GRANT SELECT ON interest_options TO kidos_app;

INSERT INTO interest_options (key, label, sort_order) VALUES
  ('magic', 'Magic and entertainment', 10), ('storytelling', 'Storytelling and puppets', 20), ('music', 'Music', 30), ('dance', 'Dance', 40),
  ('science', 'Science experiments', 50), ('robotics', 'Robotics', 60), ('coding', 'Coding', 70), ('astronomy', 'Astronomy', 80),
  ('art_craft', 'Art and crafts', 90), ('chess', 'Chess and board games', 100), ('cooking', 'Cooking', 110), ('nature', 'Nature and gardening', 120),
  ('cricket', 'Cricket', 130), ('football', 'Football', 140), ('badminton', 'Badminton and racket sports', 150), ('swimming', 'Swimming', 160),
  ('yoga', 'Yoga and fitness', 170), ('martial_arts', 'Martial arts', 180), ('cycling', 'Cycling and outdoor play', 190), ('vr_gaming', 'VR and gaming', 200);

CREATE TABLE families (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL UNIQUE REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE children (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  nickname    text NOT NULL CHECK (length(btrim(nickname)) BETWEEN 1 AND 40),
  birth_year  integer NOT NULL CHECK (birth_year BETWEEN 2000 AND 2100),
  interests   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 10),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX children_family_idx ON children (family_id);
CREATE TRIGGER children_updated_at BEFORE UPDATE ON children FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  kind          text NOT NULL CHECK (kind IN ('guardian_child_data')),
  version       text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE INDEX consents_user_idx ON consents (user_id, kind);
-- At most one live (not withdrawn) consent of each kind per person.
CREATE UNIQUE INDEX consents_one_live ON consents (user_id, kind) WHERE withdrawn_at IS NULL;

ALTER TABLE families ENABLE ROW LEVEL SECURITY; ALTER TABLE families FORCE ROW LEVEL SECURITY;
ALTER TABLE children ENABLE ROW LEVEL SECURITY; ALTER TABLE children FORCE ROW LEVEL SECURITY;
ALTER TABLE consents ENABLE ROW LEVEL SECURITY; ALTER TABLE consents FORCE ROW LEVEL SECURITY;

CREATE POLICY families_owner ON families FOR ALL
  USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id());
CREATE POLICY children_owner ON children FOR ALL
  USING (EXISTS (SELECT 1 FROM families f WHERE f.id = children.family_id AND f.owner_user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM families f WHERE f.id = children.family_id AND f.owner_user_id = app_user_id()));
CREATE POLICY consents_owner ON consents FOR ALL
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

GRANT SELECT, INSERT ON families TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON children TO kidos_app;
GRANT SELECT, INSERT ON consents TO kidos_app;
GRANT UPDATE (withdrawn_at) ON consents TO kidos_app;
