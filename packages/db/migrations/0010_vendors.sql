-- 0010 Vendors: categories, vendor profiles, vetting, service areas, staff, community approvals, offerings, availability,
-- and the rules that decide which vendor data a RESIDENT may see.
--
-- A vendor is an organization (type 'vendor'). Its status reuses organizations.status:
--   draft -> verification (in review) -> active (approved) -> suspended
--
-- Who can see a vendor:
--   * its own staff, and the platform team: everything of theirs;
--   * a person acting in a community they belong to: only vendors that are ACTIVE, SERVE that community, and, when the
--     community's `vendor_approval_required` policy is on (the default), have been APPROVED by that community.
--   * community approvers: active vendors that serve their community, so they can approve them.
-- Nothing else about a vendor (contacts, documents, internal notes) is visible outside the vendor and the platform team.

-- ---------------------------------------------------------------------------
-- Categories (reference data, managed by the platform team)
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES categories (id),
  key          text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+$'),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description  text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent_idx ON categories (parent_id);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE categories ENABLE ROW LEVEL SECURITY; ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY categories_select ON categories FOR SELECT USING (app_user_id() IS NOT NULL);
CREATE POLICY categories_write ON categories FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT ON categories TO kidos_app;
GRANT UPDATE (parent_id, name, description, sort_order, is_active, updated_at) ON categories TO kidos_app;

INSERT INTO categories (key, name, sort_order) VALUES
  ('entertainment', 'Entertainment', 10), ('education', 'Learning and discovery', 20), ('sports', 'Sports and activities', 30), ('experiences', 'Experiences', 40);
INSERT INTO categories (parent_id, key, name, sort_order)
SELECT p.id, c.key, c.name, c.sort_order FROM (VALUES
  ('entertainment', 'magic_shows', 'Magic shows', 10), ('entertainment', 'puppet_shows', 'Puppet shows', 20),
  ('entertainment', 'clowns_balloons', 'Clowns and balloon artists', 30), ('entertainment', 'storytelling', 'Storytelling', 40),
  ('entertainment', 'music_performances', 'Music performances', 50), ('entertainment', 'dance_performances', 'Dance performances', 60),
  ('entertainment', 'kids_djs', 'Kids DJs', 70), ('entertainment', 'character_appearances', 'Character appearances', 80),
  ('entertainment', 'games_competitions', 'Games and competitions', 90),
  ('education', 'science_workshops', 'Science workshops', 10), ('education', 'robotics_stem', 'Robotics and STEM', 20),
  ('education', 'coding', 'Coding', 30), ('education', 'astronomy', 'Astronomy', 40), ('education', 'art_craft', 'Art and crafts', 50),
  ('education', 'chess_abacus', 'Chess and abacus', 60), ('education', 'music_dance_classes', 'Music and dance classes', 70),
  ('education', 'cooking', 'Cooking', 80), ('education', 'nature_gardening', 'Nature and gardening', 90),
  ('sports', 'racket_sports', 'Badminton and table tennis', 10), ('sports', 'cricket', 'Cricket', 20), ('sports', 'football_basketball', 'Football and basketball', 30),
  ('sports', 'swimming', 'Swimming', 40), ('sports', 'yoga_fitness', 'Yoga and fitness', 50), ('sports', 'martial_arts', 'Martial arts', 60),
  ('sports', 'cycling_outdoor', 'Cycling and outdoor activities', 70),
  ('experiences', 'vr_experiences', 'VR experiences', 10), ('experiences', 'planetarium', 'Planetarium', 20), ('experiences', 'exhibitions', 'Exhibitions and book fairs', 30),
  ('experiences', 'carnivals_festivals', 'Carnivals and festivals', 40), ('experiences', 'adventure', 'Adventure activities', 50)
) AS c (parent_key, key, name, sort_order) JOIN categories p ON p.key = c.parent_key AND p.parent_id IS NULL;

-- ---------------------------------------------------------------------------
-- Vetting requirements (data: what a vendor must prove before it can be approved)
-- ---------------------------------------------------------------------------
CREATE TABLE vetting_requirements (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  label        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_required  boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0
);
ALTER TABLE vetting_requirements ENABLE ROW LEVEL SECURITY; ALTER TABLE vetting_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY vetting_requirements_select ON vetting_requirements FOR SELECT USING (app_user_id() IS NOT NULL);
GRANT SELECT ON vetting_requirements TO kidos_app;
INSERT INTO vetting_requirements (key, label, description, is_required, sort_order) VALUES
  ('identity_proof', 'Identity proof', 'A government-issued identity document of the owner or lead performer, sighted by the platform team.', true, 10),
  ('background_check', 'Background check', 'Police verification or a background-check attestation, required for anyone working with children.', true, 20),
  ('child_safety_training', 'Child safety briefing', 'Completion of the platform''s child-safety briefing or an equivalent certificate.', true, 30),
  ('business_registration', 'Business registration', 'Registration or licence for a business (not needed for an individual performer).', false, 40),
  ('insurance', 'Liability insurance', 'Public liability insurance for the activity, where relevant.', false, 50),
  ('first_aid', 'First-aid certificate', 'A current first-aid certificate, recommended for sports and adventure activities.', false, 60),
  ('references', 'References', 'Two references from previous clients, such as other communities or schools.', false, 70);

-- ---------------------------------------------------------------------------
-- Vendor profile (public), private details, platform-only notes, status history
-- ---------------------------------------------------------------------------
CREATE TABLE vendor_profiles (
  tenant_id         uuid PRIMARY KEY REFERENCES organizations (id),
  business_type     text NOT NULL DEFAULT 'individual' CHECK (business_type IN ('individual', 'business')),
  tagline           text CHECK (tagline IS NULL OR length(tagline) <= 140),
  description       text CHECK (description IS NULL OR length(description) <= 3000),
  country           text,
  state             text,
  city              text,
  locality          text,
  years_experience  integer CHECK (years_experience IS NULL OR years_experience BETWEEN 0 AND 80),
  website           text CHECK (website IS NULL OR website ~ '^https?://'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER vendor_profiles_updated_at BEFORE UPDATE ON vendor_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vendor_private (
  tenant_id            uuid PRIMARY KEY REFERENCES organizations (id),
  legal_name           text,
  registration_number  text,
  contact_name         text,
  contact_email        text,
  contact_phone        text,
  address              text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER vendor_private_updated_at BEFORE UPDATE ON vendor_private FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vendor_internal_notes (
  tenant_id   uuid PRIMARY KEY REFERENCES organizations (id),
  notes       text NOT NULL CHECK (length(notes) <= 2000),
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_status_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations (id),
  from_status  text,
  to_status    text NOT NULL,
  note         text,
  changed_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_status_history_tenant_idx ON vendor_status_history (tenant_id, created_at DESC);
CREATE TRIGGER vendor_status_history_no_update BEFORE UPDATE OR DELETE ON vendor_status_history FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Vendor staff are memberships in the vendor organization. Which vendor roles may be handed out by vendor staff:
CREATE FUNCTION app_is_vendor_staff_role(role_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id IS NULL AND r.key IN ('vendor_admin', 'vendor_staff', 'vendor_service_provider'))
$$;
GRANT EXECUTE ON FUNCTION app_is_vendor_staff_role(uuid) TO kidos_app;

-- ---------------------------------------------------------------------------
-- Categories, service areas, documents, availability
-- ---------------------------------------------------------------------------
CREATE TABLE vendor_categories (
  tenant_id    uuid NOT NULL REFERENCES organizations (id),
  category_id  uuid NOT NULL REFERENCES categories (id),
  PRIMARY KEY (tenant_id, category_id)
);

CREATE TABLE vendor_service_areas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations (id),
  community_id     uuid REFERENCES organizations (id),
  city             text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 80),
  travel_fee_minor integer NOT NULL DEFAULT 0 CHECK (travel_fee_minor >= 0),
  travel_note      text CHECK (travel_note IS NULL OR length(travel_note) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((community_id IS NOT NULL) <> (city IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_service_areas_community_unique ON vendor_service_areas (tenant_id, community_id) WHERE community_id IS NOT NULL;
CREATE UNIQUE INDEX vendor_service_areas_city_unique ON vendor_service_areas (tenant_id, lower(city)) WHERE city IS NOT NULL;
CREATE INDEX vendor_service_areas_community_idx ON vendor_service_areas (community_id);

CREATE TABLE vendor_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organizations (id),
  requirement_key  text NOT NULL REFERENCES vetting_requirements (key),
  title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  reference        text CHECK (reference IS NULL OR length(reference) <= 300),   -- where it was sighted, document number, etc. (no file upload yet)
  issued_on        date,
  expires_on       date,
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'verified', 'rejected')),
  reviewed_by      uuid REFERENCES users (id),
  reviewed_at      timestamptz,
  review_note      text CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX vendor_documents_tenant_idx ON vendor_documents (tenant_id, requirement_key);

CREATE TABLE vendor_availability_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),      -- 0 = Sunday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX vendor_availability_rules_tenant_idx ON vendor_availability_rules (tenant_id, weekday);

CREATE TABLE vendor_unavailable_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text CHECK (reason IS NULL OR length(reason) <= 200),
  CHECK (ends_at > starts_at)
);
CREATE INDEX vendor_unavailable_blocks_tenant_idx ON vendor_unavailable_blocks (tenant_id, starts_at);

-- ---------------------------------------------------------------------------
-- A community's decision about a vendor
-- ---------------------------------------------------------------------------
CREATE TABLE community_vendor_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),       -- the community deciding
  vendor_id   uuid NOT NULL REFERENCES organizations (id),
  status      text NOT NULL CHECK (status IN ('approved', 'rejected', 'revoked')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  decided_by  uuid REFERENCES users (id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, vendor_id)
);

-- ---------------------------------------------------------------------------
-- Offerings
-- ---------------------------------------------------------------------------
CREATE TABLE offerings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organizations (id),       -- the vendor
  category_id           uuid NOT NULL REFERENCES categories (id),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description           text CHECK (description IS NULL OR length(description) <= 3000),
  offering_type         text NOT NULL DEFAULT 'service' CHECK (offering_type IN ('service', 'workshop', 'experience')),
  pricing_model         text NOT NULL CHECK (pricing_model IN ('fixed', 'hourly', 'per_participant', 'per_event', 'per_day', 'package', 'custom_quotation')),
  price_minor           bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency              char(3) NOT NULL DEFAULT 'INR',
  duration_minutes      integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 1440),
  min_participants      integer CHECK (min_participants IS NULL OR min_participants BETWEEN 1 AND 10000),
  max_participants      integer CHECK (max_participants IS NULL OR max_participants BETWEEN 1 AND 10000),
  age_min               integer CHECK (age_min IS NULL OR age_min BETWEEN 0 AND 100),
  age_max               integer CHECK (age_max IS NULL OR age_max BETWEEN 0 AND 100),
  equipment             text CHECK (equipment IS NULL OR length(equipment) <= 1000),
  venue_requirements    text CHECK (venue_requirements IS NULL OR length(venue_requirements) <= 1000),
  additional_charges    text CHECK (additional_charges IS NULL OR length(additional_charges) <= 1000),
  terms                 text CHECK (terms IS NULL OR length(terms) <= 3000),
  cancellation_policy   text CHECK (cancellation_policy IS NULL OR length(cancellation_policy) <= 1500),
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (pricing_model = 'custom_quotation' OR price_minor IS NOT NULL),
  CHECK (max_participants IS NULL OR min_participants IS NULL OR max_participants >= min_participants),
  CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min)
);
CREATE INDEX offerings_tenant_idx ON offerings (tenant_id, status);
CREATE INDEX offerings_category_idx ON offerings (category_id) WHERE status = 'published';
CREATE TRIGGER offerings_updated_at BEFORE UPDATE ON offerings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_profiles', 'vendor_private', 'vendor_internal_notes', 'vendor_status_history', 'vendor_categories',
                           'vendor_service_areas', 'vendor_documents', 'vendor_availability_rules', 'vendor_unavailable_blocks',
                           'community_vendor_approvals', 'offerings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Which vendor organizations a person acting in a community may see (used by the policies below via the organizations row)
CREATE POLICY organizations_vendor_catalog ON organizations FOR SELECT
  USING (
    type = 'vendor' AND status = 'active' AND app_user_id() IS NOT NULL
    -- the person is an active member of the community they are acting in
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app_tenant_id() AND m.user_id = app_user_id() AND m.status = 'active')
    -- the vendor serves that community
    AND EXISTS (SELECT 1 FROM vendor_service_areas sa WHERE sa.tenant_id = organizations.id AND sa.community_id = app_tenant_id())
    -- and, unless the community turned the policy off, the community has approved it
    AND (
      NOT COALESCE((SELECT p.value = 'true'::jsonb FROM community_policies p WHERE p.tenant_id = app_tenant_id() AND p.key = 'vendor_approval_required'), true)
      OR EXISTS (SELECT 1 FROM community_vendor_approvals a WHERE a.tenant_id = app_tenant_id() AND a.vendor_id = organizations.id AND a.status = 'approved')
    )
  );
-- Community approvers see active vendors that serve their community, so they can decide about them.
CREATE POLICY organizations_vendor_for_approvers ON organizations FOR SELECT
  USING (
    type = 'vendor' AND status = 'active'
    AND app_ctx_has_any_permission(ARRAY['community.approve_vendor'])
    AND EXISTS (SELECT 1 FROM vendor_service_areas sa WHERE sa.tenant_id = organizations.id AND sa.community_id = app_tenant_id())
  );

-- Public vendor data: visible exactly when the vendor's organization row is visible to the caller (the two policies above,
-- the vendor's own members, or the platform), because EXISTS(...organizations...) is evaluated under the caller's rights.
CREATE POLICY vendor_profiles_select ON vendor_profiles FOR SELECT
  USING (EXISTS (SELECT 1 FROM organizations v WHERE v.id = vendor_profiles.tenant_id));
CREATE POLICY vendor_profiles_insert ON vendor_profiles FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));
CREATE POLICY vendor_profiles_update ON vendor_profiles FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));

CREATE POLICY vendor_categories_select ON vendor_categories FOR SELECT
  USING (EXISTS (SELECT 1 FROM organizations v WHERE v.id = vendor_categories.tenant_id));
CREATE POLICY vendor_categories_write ON vendor_categories FOR ALL
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));

CREATE POLICY offerings_select ON offerings FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['offerings.manage', 'vendors.read', 'inquiries.respond']))
    OR (status = 'published' AND EXISTS (SELECT 1 FROM organizations v WHERE v.id = offerings.tenant_id))
  );
CREATE POLICY offerings_insert ON offerings FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('offerings.manage')));
CREATE POLICY offerings_update ON offerings FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('offerings.manage')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('offerings.manage')));

-- Service areas: the vendor and platform manage them; a community's own context can see which vendors serve it
-- (only ids and fees: names and details of vendors it may not see stay hidden by the organizations policies above).
CREATE POLICY vendor_service_areas_select ON vendor_service_areas FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['vendors.read', 'vendors.update']))
    OR community_id = app_tenant_id()
  );
CREATE POLICY vendor_service_areas_write ON vendor_service_areas FOR ALL
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));

-- Private vendor details, notes and history: the vendor's own people with the right permission, and the platform.
CREATE POLICY vendor_private_select ON vendor_private FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['vendors.read'])));
CREATE POLICY vendor_private_insert ON vendor_private FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));
CREATE POLICY vendor_private_update ON vendor_private FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));
CREATE POLICY vendor_internal_notes_platform ON vendor_internal_notes FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY vendor_status_history_select ON vendor_status_history FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['vendors.read'])));
CREATE POLICY vendor_status_history_insert ON vendor_status_history FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendors.update')));

-- Documents: vendor staff may add and withdraw their own submissions but can never mark them verified.
CREATE POLICY vendor_documents_select ON vendor_documents FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['vendor_documents.manage', 'vendors.read', 'vendors.vet'])));
CREATE POLICY vendor_documents_insert ON vendor_documents FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendor_documents.manage') AND status = 'submitted'));
CREATE POLICY vendor_documents_update ON vendor_documents FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendor_documents.manage') AND status = 'submitted'))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendor_documents.manage') AND status = 'submitted'));
CREATE POLICY vendor_documents_delete ON vendor_documents FOR DELETE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('vendor_documents.manage') AND status = 'submitted'));

CREATE POLICY vendor_availability_rules_select ON vendor_availability_rules FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['availability.manage', 'vendors.read', 'inquiries.respond'])));
CREATE POLICY vendor_availability_rules_write ON vendor_availability_rules FOR ALL
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('availability.manage')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('availability.manage')));
CREATE POLICY vendor_unavailable_blocks_select ON vendor_unavailable_blocks FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['availability.manage', 'vendors.read', 'inquiries.respond'])));
CREATE POLICY vendor_unavailable_blocks_write ON vendor_unavailable_blocks FOR ALL
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('availability.manage')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('availability.manage')));

-- Community approvals. The community's approvers (and platform) decide; members can see APPROVED rows (that is what
-- makes a vendor visible to them); the vendor can see decisions about itself.
CREATE POLICY community_vendor_approvals_select ON community_vendor_approvals FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (status = 'approved' OR app_ctx_has_any_permission(ARRAY['community.approve_vendor', 'communities.read'])))
    OR (vendor_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['vendors.read']))
  );
CREATE POLICY community_vendor_approvals_insert ON community_vendor_approvals FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('community.approve_vendor')));
CREATE POLICY community_vendor_approvals_update ON community_vendor_approvals FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('community.approve_vendor')))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND app_has_permission('community.approve_vendor')));

-- ---------------------------------------------------------------------------
-- Vendor staff: extend the membership and role rules (0007) so a vendor's own staff managers can add and manage
-- people in THEIR vendor, with vendor-level roles only.
-- ---------------------------------------------------------------------------
DROP POLICY memberships_insert ON memberships;
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
         app_has_permission('memberships.approve')
         OR app_has_permission('vendor_staff.manage')
         OR (user_id = app_user_id() AND status = 'pending' AND join_method = 'admin_approval' AND app_tenant_is_active_community())
         OR (user_id = app_user_id() AND status = 'active' AND join_method = 'invite_code' AND app_tenant_is_active_community() AND app_invite_valid())
    ))
  );
DROP POLICY memberships_update ON memberships;
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (app_has_permission('memberships.approve') OR app_has_permission('vendor_staff.manage')))
    OR user_id = app_user_id()
  )
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (app_has_permission('memberships.approve') OR app_has_permission('vendor_staff.manage')))
    OR (user_id = app_user_id() AND tenant_id = app_tenant_id() AND status = 'removed')
  );
DROP POLICY memberships_delete ON memberships;
CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND (app_has_permission('memberships.approve') OR app_has_permission('vendor_staff.manage'))));

DROP POLICY role_assignments_insert ON role_assignments;
CREATE POLICY role_assignments_insert ON role_assignments FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
         app_has_permission('roles.manage')
         OR (app_has_permission('memberships.approve') AND app_is_member_role(role_id))
         OR (app_has_permission('vendor_staff.manage') AND app_is_vendor_staff_role(role_id))
         OR (user_id = app_user_id() AND app_is_member_role(role_id)
             AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = role_assignments.tenant_id AND m.user_id = app_user_id() AND m.status = 'active'))
    ))
  );
DROP POLICY role_assignments_delete ON role_assignments;
CREATE POLICY role_assignments_delete ON role_assignments FOR DELETE
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (
         app_has_permission('roles.manage')
         OR (app_has_permission('memberships.approve') AND app_is_member_role(role_id))
         OR (app_has_permission('vendor_staff.manage') AND app_is_vendor_staff_role(role_id))
    ))
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON vendor_profiles, vendor_private, offerings TO kidos_app;
GRANT SELECT, INSERT                 ON vendor_internal_notes, vendor_status_history TO kidos_app;
GRANT UPDATE (notes, updated_by, updated_at) ON vendor_internal_notes TO kidos_app;
GRANT SELECT, INSERT, DELETE         ON vendor_categories TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_service_areas, vendor_availability_rules, vendor_unavailable_blocks TO kidos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_documents TO kidos_app;
GRANT SELECT, INSERT, UPDATE         ON community_vendor_approvals TO kidos_app;
