-- 0012 Requests and the operations workflow (Phase 5).
--
-- A resident submits a request in their community; the platform's operations desk works it through a workflow stored as
-- DATA (statuses, allowed transitions with the permission each needs, SLA hours). The database itself enforces the
-- workflow with a trigger, so an allowed-looking API call cannot skip a step, and every status change writes an
-- append-only history row.
--
-- Visibility: the requester sees their own requests; a community's administrators can read (not change) their
-- community's requests; the platform team sees everything. Internal notes are never visible to the resident or the
-- community. Children are NOT referenced by identity: a request carries only a count and an age range.

-- ---------------------------------------------------------------------------
-- Reference data (no tenant): statuses, transitions, SLA rules, request types
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_statuses (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- who the request is waiting on in this status: drives the SLA clock owner and the resident's "what happens next"
  waiting_on  text NOT NULL CHECK (waiting_on IN ('operations', 'resident', 'none')),
  is_terminal boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE workflow_transitions (
  from_status   text NOT NULL REFERENCES workflow_statuses (key),
  to_status     text NOT NULL REFERENCES workflow_statuses (key),
  -- 'staff': the operations team (permission checked against the verified request permissions);
  -- 'requester': the person who made the request (and only them)
  actor         text NOT NULL CHECK (actor IN ('staff', 'requester')),
  permission    text NOT NULL,
  note_required boolean NOT NULL DEFAULT false,
  label         text NOT NULL,
  PRIMARY KEY (from_status, to_status, actor)
);

CREATE TABLE sla_rules (
  status text PRIMARY KEY REFERENCES workflow_statuses (key),
  hours  integer NOT NULL CHECK (hours > 0)
);

CREATE TABLE request_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+$'),
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  -- {"fields":[{"key","label","type","required","options":[{"value","label"}],"min","max","hint"}]}
  form_schema    jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_statuses', 'workflow_transitions', 'sla_rules', 'request_types']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_user_id() IS NOT NULL)', t || '_select', t);
    EXECUTE format('GRANT SELECT ON %I TO kidos_app', t);
  END LOOP;
END $$;

INSERT INTO workflow_statuses (key, label, description, waiting_on, is_terminal, sort_order) VALUES
  ('draft',                'Draft',                 'Not submitted yet.',                                          'resident',   false, 10),
  ('submitted',            'Submitted',             'Received. The team will look at it soon.',                    'operations', false, 20),
  ('under_review',         'Under review',          'The team is reviewing the request.',                          'operations', false, 30),
  ('information_required', 'We need more information', 'The team has a question for you.',                         'resident',   false, 40),
  ('approved',             'Approved',              'The request is approved and the team will start sourcing.',   'operations', false, 50),
  ('sourcing',             'Finding options',       'The team is finding suitable vendors.',                       'operations', false, 60),
  ('vendor_inquiry',       'Asking vendors',        'Vendors have been asked about availability and price.',       'operations', false, 70),
  ('quotes_received',      'Quotes received',       'Quotes are in and being compared.',                           'operations', false, 80),
  ('shortlisted',          'Shortlisted',           'Options have been shortlisted.',                              'operations', false, 90),
  ('community_approval',   'Waiting for community approval', 'Your community needs to approve this.',              'operations', false, 100),
  ('booking_pending',      'Booking pending',       'Confirming the booking.',                                     'operations', false, 110),
  ('confirmed',            'Confirmed',             'The booking is confirmed.',                                   'none',       false, 120),
  ('scheduled',            'Scheduled',             'The date is scheduled.',                                      'none',       false, 130),
  ('in_progress',          'In progress',           'Happening now.',                                              'none',       false, 140),
  ('completed',            'Completed',             'Done.',                                                       'none',       true,  150),
  ('cancelled',            'Cancelled',             'Cancelled.',                                                  'none',       true,  160),
  ('rejected',             'Not possible',          'The team could not take this request on.',                    'none',       true,  170),
  ('closed',               'Closed',                'Closed without a booking.',                                   'none',       true,  180);

-- Phase 5 covers Submitted to Approved (and the exits). Later phases add the sourcing and booking steps here, as data.
INSERT INTO workflow_transitions (from_status, to_status, actor, permission, note_required, label) VALUES
  ('submitted',            'under_review',         'staff',     'requests.transition',   false, 'Start review'),
  ('submitted',            'rejected',             'staff',     'requests.transition',   true,  'Cannot take this on'),
  ('submitted',            'cancelled',            'requester', 'requests.cancel_own',   false, 'Cancel my request'),
  ('under_review',         'information_required', 'staff',     'requests.transition',   true,  'Ask for more information'),
  ('under_review',         'approved',             'staff',     'requests.transition',   false, 'Approve'),
  ('under_review',         'rejected',             'staff',     'requests.transition',   true,  'Cannot take this on'),
  ('under_review',         'cancelled',            'requester', 'requests.cancel_own',   false, 'Cancel my request'),
  ('information_required', 'under_review',         'requester', 'requests.comment_public', false, 'Send my reply'),
  ('information_required', 'under_review',         'staff',     'requests.transition',   false, 'Back to review'),
  ('information_required', 'rejected',             'staff',     'requests.transition',   true,  'Cannot take this on'),
  ('information_required', 'cancelled',            'requester', 'requests.cancel_own',   false, 'Cancel my request'),
  ('approved',             'closed',               'staff',     'requests.transition',   true,  'Close without a booking'),
  ('approved',             'cancelled',            'requester', 'requests.cancel_own',   false, 'Cancel my request');

-- First response and review targets (operations clock); the resident's clock (information required) is not an ops breach.
INSERT INTO sla_rules (status, hours) VALUES ('submitted', 24), ('under_review', 48), ('information_required', 120);

INSERT INTO request_types (key, name, description, form_schema, sort_order) VALUES
  ('activity', 'Find an activity or service', 'Tell us what your child would enjoy and we will find trusted options.',
   '{"fields":[
      {"key":"format","label":"One time or regular?","type":"select","required":true,"options":[{"value":"one_time","label":"One time"},{"value":"recurring","label":"Regular classes"}]},
      {"key":"setting","label":"Indoor or outdoor?","type":"select","required":false,"options":[{"value":"indoor","label":"Indoor"},{"value":"outdoor","label":"Outdoor"},{"value":"either","label":"Either is fine"}]},
      {"key":"special_needs","label":"Anything we should know?","type":"long_text","required":false,"max":500,"hint":"For example allergies or accessibility needs. Please do not include names or phone numbers."}
    ]}'::jsonb, 10),
  ('celebration', 'Plan a birthday or celebration', 'Entertainment and help for a party or community celebration.',
   '{"fields":[
      {"key":"occasion","label":"What is the occasion?","type":"select","required":true,"options":[{"value":"birthday","label":"Birthday"},{"value":"festival","label":"Festival"},{"value":"school_event","label":"School or group event"},{"value":"other","label":"Something else"}]},
      {"key":"guest_count","label":"How many guests?","type":"number","required":true,"min":1,"max":500},
      {"key":"venue_type","label":"Where will it be?","type":"select","required":true,"options":[{"value":"community_facility","label":"A community venue"},{"value":"home","label":"At home"},{"value":"other","label":"Somewhere else"}]},
      {"key":"food_allowed","label":"Can vendors serve food?","type":"boolean","required":false},
      {"key":"theme","label":"Theme or style (optional)","type":"text","required":false,"max":120},
      {"key":"special_needs","label":"Anything we should know?","type":"long_text","required":false,"max":500,"hint":"For example allergies or accessibility needs. Please do not include names or phone numbers."}
    ]}'::jsonb, 20),
  ('workshop', 'Arrange a workshop or class', 'A learning or hobby session for a group of children.',
   '{"fields":[
      {"key":"topic","label":"What should it be about?","type":"text","required":true,"max":120},
      {"key":"sessions","label":"How many sessions?","type":"number","required":true,"min":1,"max":52},
      {"key":"skill_level","label":"Skill level","type":"select","required":false,"options":[{"value":"beginner","label":"Beginner"},{"value":"intermediate","label":"Intermediate"},{"value":"advanced","label":"Advanced"},{"value":"mixed","label":"Mixed"}]},
      {"key":"equipment_available","label":"Is equipment or a room available?","type":"boolean","required":false},
      {"key":"special_needs","label":"Anything we should know?","type":"long_text","required":false,"max":500,"hint":"For example allergies or accessibility needs. Please do not include names or phone numbers."}
    ]}'::jsonb, 30);

-- ---------------------------------------------------------------------------
-- Requests (tenant = the community the request is for)
-- ---------------------------------------------------------------------------
CREATE TABLE requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number    bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id         uuid NOT NULL REFERENCES organizations (id),
  requester_id      uuid NOT NULL REFERENCES users (id),
  request_type_id   uuid NOT NULL REFERENCES request_types (id),
  schema_version    integer NOT NULL,
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  description       text CHECK (description IS NULL OR length(description) <= 3000),
  category_id       uuid REFERENCES categories (id),
  offering_id       uuid REFERENCES offerings (id),
  preferred_date    date,
  flexible_dates    boolean NOT NULL DEFAULT false,
  participant_count integer CHECK (participant_count IS NULL OR participant_count BETWEEN 1 AND 1000),
  age_min           integer CHECK (age_min IS NULL OR age_min BETWEEN 0 AND 100),
  age_max           integer CHECK (age_max IS NULL OR age_max BETWEEN 0 AND 100),
  budget_max_minor  bigint CHECK (budget_max_minor IS NULL OR budget_max_minor >= 0),
  venue_text        text CHECK (venue_text IS NULL OR length(venue_text) <= 200),
  answers           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  status            text NOT NULL DEFAULT 'submitted' REFERENCES workflow_statuses (key),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- when the current status's target is due (NULL when the status has no target); set only by the workflow trigger
  sla_due_at        timestamptz,
  assigned_to       uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min)
);
CREATE INDEX requests_tenant_status_idx ON requests (tenant_id, status, created_at DESC);
CREATE INDEX requests_requester_idx ON requests (requester_id, created_at DESC);
CREATE INDEX requests_queue_idx ON requests (status, sla_due_at) WHERE sla_due_at IS NOT NULL;
CREATE TRIGGER requests_updated_at BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE request_status_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES organizations (id),
  request_id uuid NOT NULL REFERENCES requests (id),
  from_status text,
  to_status  text NOT NULL,
  -- shown to the resident: write internal remarks as internal comments instead
  note       text CHECK (note IS NULL OR length(note) <= 1000),
  changed_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_status_history_idx ON request_status_history (request_id, created_at);
CREATE TRIGGER request_status_history_immutable BEFORE UPDATE OR DELETE ON request_status_history FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE request_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES organizations (id),
  request_id uuid NOT NULL REFERENCES requests (id),
  author_id  uuid NOT NULL REFERENCES users (id),
  visibility text NOT NULL CHECK (visibility IN ('resident', 'internal')),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_comments_idx ON request_comments (request_id, created_at);
CREATE TRIGGER request_comments_immutable BEFORE UPDATE OR DELETE ON request_comments FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

ALTER TABLE requests ENABLE ROW LEVEL SECURITY;               ALTER TABLE requests FORCE ROW LEVEL SECURITY;
ALTER TABLE request_status_history ENABLE ROW LEVEL SECURITY; ALTER TABLE request_status_history FORCE ROW LEVEL SECURITY;
ALTER TABLE request_comments ENABLE ROW LEVEL SECURITY;       ALTER TABLE request_comments FORCE ROW LEVEL SECURITY;

-- Requests: the requester, the community's request readers, and the platform.
CREATE POLICY requests_select ON requests FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND (requester_id = app_user_id() OR app_ctx_has_any_permission(ARRAY['requests.read_community'])))
  );
-- A resident creates their own request, as themselves, in a community they are an active member of, in status 'submitted'.
CREATE POLICY requests_insert ON requests FOR INSERT
  WITH CHECK (
    tenant_id = app_tenant_id() AND requester_id = app_user_id() AND status = 'submitted'
    AND app_has_permission('requests.create_own') AND app_tenant_is_active_community()
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = requests.tenant_id AND m.user_id = app_user_id() AND m.status = 'active')
  );
-- Who may change a row at all. WHAT they may change, and to which status, is decided by the workflow trigger below.
CREATE POLICY requests_update ON requests FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND requester_id = app_user_id()))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND requester_id = app_user_id()));
GRANT SELECT, INSERT ON requests TO kidos_app;
GRANT UPDATE (status, assigned_to, status_changed_at, sla_due_at, updated_at) ON requests TO kidos_app;

CREATE POLICY request_status_history_select ON request_status_history FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_status_history.request_id))
  );
CREATE POLICY request_status_history_insert ON request_status_history FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_status_history.request_id AND r.requester_id = app_user_id()))
  );
GRANT SELECT, INSERT ON request_status_history TO kidos_app;

-- Comments: internal ones only for the platform. Residents (and the community's readers) see resident-visible ones.
CREATE POLICY request_comments_select ON request_comments FOR SELECT
  USING (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND visibility = 'resident' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_comments.request_id))
  );
CREATE POLICY request_comments_insert ON request_comments FOR INSERT
  WITH CHECK (
    author_id = app_user_id()
    AND (
      app_is_platform()
      OR (tenant_id = app_tenant_id() AND visibility = 'resident' AND app_has_permission('requests.comment_public')
          AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_comments.request_id AND r.requester_id = app_user_id()))
    )
  );
GRANT SELECT, INSERT ON request_comments TO kidos_app;

-- ---------------------------------------------------------------------------
-- The workflow, enforced by the database
-- ---------------------------------------------------------------------------
-- New requests start 'submitted' with their first target; nobody pre-assigns or back-dates.
CREATE FUNCTION requests_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.status_changed_at := now();
  NEW.sla_due_at := (SELECT now() + make_interval(hours => s.hours) FROM sla_rules s WHERE s.status = NEW.status);
  NEW.assigned_to := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER requests_a_on_insert BEFORE INSERT ON requests FOR EACH ROW EXECUTE FUNCTION requests_on_insert();

CREATE FUNCTION requests_record_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO request_status_history (tenant_id, request_id, from_status, to_status, changed_by) VALUES (NEW.tenant_id, NEW.id, NULL, NEW.status, NEW.requester_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER requests_b_record_creation AFTER INSERT ON requests FOR EACH ROW EXECUTE FUNCTION requests_record_creation();

-- A status change must follow a row of workflow_transitions, by an actor allowed to take it, with a note where one is
-- required; it restarts the target clock and writes the history row (the note comes from the transaction-local setting
-- app.note, which the API sets). Assigning needs requests.assign and an operations team member as the assignee.
CREATE FUNCTION requests_enforce_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w workflow_transitions;
  note text := NULLIF(btrim(COALESCE(current_setting('app.note', true), '')), '');
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    IF NOT app_ctx_has_any_permission(ARRAY['requests.assign']) THEN
      RAISE EXCEPTION 'assigning a request needs the requests.assign permission' USING ERRCODE = '42501';
    END IF;
    -- (platform_staff itself shows a person only their own row, so "on the team" means: holds a role in the platform organization)
    IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM role_assignments ra
          WHERE ra.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND ra.user_id = NEW.assigned_to) THEN
      RAISE EXCEPTION 'a request can only be assigned to a member of the operations team' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT * INTO w FROM workflow_transitions t
     WHERE t.from_status = OLD.status AND t.to_status = NEW.status
       AND ((t.actor = 'staff' AND app_ctx_has_any_permission(ARRAY[t.permission]))
         OR (t.actor = 'requester' AND OLD.requester_id = app_user_id() AND app_has_permission(t.permission)))
     ORDER BY t.actor LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'this request cannot move from % to % for this person', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF w.note_required AND note IS NULL THEN
      RAISE EXCEPTION 'a note is required for this step' USING ERRCODE = '23514';
    END IF;
    NEW.status_changed_at := now();
    NEW.sla_due_at := (SELECT now() + make_interval(hours => s.hours) FROM sla_rules s WHERE s.status = NEW.status);
    INSERT INTO request_status_history (tenant_id, request_id, from_status, to_status, note, changed_by)
    VALUES (OLD.tenant_id, OLD.id, OLD.status, NEW.status, note, app_user_id());
  ELSE
    -- no status change: the clock fields can never be edited directly
    NEW.status_changed_at := OLD.status_changed_at;
    NEW.sla_due_at := OLD.sla_due_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER requests_a_enforce_workflow BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION requests_enforce_workflow();
