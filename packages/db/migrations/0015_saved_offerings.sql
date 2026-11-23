-- 0015 Phase 7 (Discovery catalog, minimal slice): saved offerings.
--
-- A resident can save an offering from their community's catalog to find it again. The list is PRIVATE to the person:
-- nobody else (not the community administrators, not operations, not the vendor) can read it. A saved row only records
-- that this person, acting in this community, saved this offering; what they may still SEE of it is decided, as
-- always, by the offerings policies (an offering that is unpublished, or whose vendor is suspended or no longer
-- approved by the community, simply stops appearing in their saved list; the row is not exposed).

CREATE TABLE saved_offerings (
  tenant_id   uuid NOT NULL REFERENCES organizations (id),   -- the community the person was in when saving
  user_id     uuid NOT NULL REFERENCES users (id),
  offering_id uuid NOT NULL REFERENCES offerings (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, offering_id)
);
CREATE INDEX saved_offerings_offering_idx ON saved_offerings (offering_id);

ALTER TABLE saved_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_offerings FORCE ROW LEVEL SECURITY;

-- Your own rows, in the community you are acting in. No platform clause on purpose: a person's saved list is not
-- something operations need to read.
CREATE POLICY saved_offerings_select ON saved_offerings FOR SELECT
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id());

-- Saving requires the catalog permission and an offering that the caller can see right now (published, vendor visible
-- to this community). The existence test runs under the caller's own row-level security.
CREATE POLICY saved_offerings_insert ON saved_offerings FOR INSERT
  WITH CHECK (
    NOT app_is_platform() AND tenant_id = app_tenant_id() AND user_id = app_user_id() AND app_has_permission('catalog.read')
    AND EXISTS (SELECT 1 FROM offerings o WHERE o.id = saved_offerings.offering_id AND o.status = 'published')
  );

CREATE POLICY saved_offerings_delete ON saved_offerings FOR DELETE
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id());

-- Insert and delete only: a saved offering is never edited.
GRANT SELECT, INSERT, DELETE ON saved_offerings TO kidos_app;

-- A person may keep at most 200 saved offerings per community (a backstop; the API gives a friendly message first).
CREATE FUNCTION saved_offerings_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM saved_offerings s WHERE s.tenant_id = NEW.tenant_id AND s.user_id = NEW.user_id) >= 200 THEN
    RAISE EXCEPTION 'too many saved offerings' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER saved_offerings_a_limit BEFORE INSERT ON saved_offerings FOR EACH ROW EXECUTE FUNCTION saved_offerings_limit();
