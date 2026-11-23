-- 0013 Sourcing and booking (Phase 6.1 and 6.2): matching, vendor inquiries, quotes, shortlist, acceptance, bookings.
--
-- The operations team finds vendors for an approved request, asks several of them, compares their quotes and offers the
-- best to the family, who accepts one. A booking then follows: scheduled by operations, confirmed by the vendor, then by
-- operations, and finally completed.
--
-- PRIVACY: a vendor never reads a request and never learns who asked. An inquiry carries a SNAPSHOT of what the vendor
-- needs to quote (what, when, how many children, ages, budget, the community's name and area). Residents see only the
-- quotes operations chose to offer them. Vendors see only inquiries, quotes and bookings addressed to them.
--
-- Request statuses and transitions stay DATA (migration 0012): this migration adds the rows for the new steps.

-- ---------------------------------------------------------------------------
-- Permissions and workflow data
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES ('quotes.accept', 'Accept a quote offered for your request');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'quotes.accept' FROM roles r WHERE r.tenant_id IS NULL AND r.key IN ('resident', 'parent_guardian', 'super_admin');

-- Waiting for the family to choose is the family's clock, not the team's.
UPDATE workflow_statuses SET waiting_on = 'resident' WHERE key = 'shortlisted';
INSERT INTO sla_rules (status, hours) VALUES ('sourcing', 72), ('vendor_inquiry', 96), ('quotes_received', 24), ('shortlisted', 120), ('booking_pending', 48);

INSERT INTO workflow_transitions (from_status, to_status, actor, permission, note_required, label) VALUES
  ('approved',        'sourcing',        'staff',     'requests.transition', false, 'Start finding vendors'),
  ('sourcing',        'vendor_inquiry',  'staff',     'requests.transition', false, 'Vendors have been asked'),
  ('vendor_inquiry',  'quotes_received', 'staff',     'requests.transition', false, 'Quotes are in'),
  ('quotes_received', 'vendor_inquiry',  'staff',     'requests.transition', false, 'Ask more vendors'),
  ('quotes_received', 'shortlisted',     'staff',     'requests.transition', false, 'Offer these options to the family'),
  ('shortlisted',     'quotes_received', 'staff',     'requests.transition', false, 'Change the options'),
  ('shortlisted',     'booking_pending', 'requester', 'quotes.accept',       false, 'Accept this quote'),
  ('booking_pending', 'confirmed',       'staff',     'bookings.confirm',    false, 'Confirm the booking'),
  ('booking_pending', 'sourcing',        'staff',     'requests.transition', true,  'Start again with other vendors'),
  ('confirmed',       'completed',       'staff',     'bookings.complete',   false, 'Mark as completed'),
  ('confirmed',       'cancelled',       'staff',     'bookings.cancel',     true,  'Cancel the booking'),
  ('sourcing',        'closed',          'staff',     'requests.transition', true,  'Close without a booking'),
  ('vendor_inquiry',  'closed',          'staff',     'requests.transition', true,  'Close without a booking'),
  ('quotes_received', 'closed',          'staff',     'requests.transition', true,  'Close without a booking'),
  ('shortlisted',     'closed',          'staff',     'requests.transition', true,  'Close without a booking'),
  ('booking_pending', 'closed',          'staff',     'requests.transition', true,  'Close without a booking'),
  ('sourcing',        'cancelled',       'requester', 'requests.cancel_own', false, 'Cancel my request'),
  ('vendor_inquiry',  'cancelled',       'requester', 'requests.cancel_own', false, 'Cancel my request'),
  ('quotes_received', 'cancelled',       'requester', 'requests.cancel_own', false, 'Cancel my request'),
  ('shortlisted',     'cancelled',       'requester', 'requests.cancel_own', false, 'Cancel my request'),
  ('booking_pending', 'cancelled',       'requester', 'requests.cancel_own', false, 'Cancel my request');

-- ---------------------------------------------------------------------------
-- Matching results (operations only): who was suggested, why, and any manual addition with its reason
-- ---------------------------------------------------------------------------
CREATE TABLE request_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),   -- the community
  request_id      uuid NOT NULL REFERENCES requests (id),
  vendor_id       uuid NOT NULL REFERENCES organizations (id),
  offering_id     uuid REFERENCES offerings (id),
  score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  source          text NOT NULL CHECK (source IN ('auto', 'manual')),
  manual_reason   text CHECK (manual_reason IS NULL OR length(manual_reason) <= 500),
  weights_version integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, vendor_id),
  CHECK (source = 'auto' OR length(btrim(COALESCE(manual_reason, ''))) > 0)
);
CREATE INDEX request_matches_request_idx ON request_matches (request_id, score DESC);

-- ---------------------------------------------------------------------------
-- Inquiries: a request, as a vendor may see it
-- ---------------------------------------------------------------------------
CREATE TABLE inquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations (id),    -- the community
  request_id     uuid NOT NULL REFERENCES requests (id),
  vendor_id      uuid NOT NULL REFERENCES organizations (id),
  offering_id    uuid REFERENCES offerings (id),
  status         text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'declined', 'quoted', 'withdrawn')),
  message        text CHECK (message IS NULL OR length(message) <= 1000),
  -- what the vendor needs to quote; never the requester's identity
  snapshot       jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) <= 500),
  sent_by        uuid REFERENCES users (id),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  responded_at   timestamptz,
  UNIQUE (request_id, vendor_id)
);
CREATE INDEX inquiries_vendor_idx ON inquiries (vendor_id, status, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Quotes and their line items
-- ---------------------------------------------------------------------------
CREATE TABLE quotes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organizations (id),
  request_id     uuid NOT NULL REFERENCES requests (id),
  inquiry_id     uuid NOT NULL REFERENCES inquiries (id),
  vendor_id      uuid NOT NULL REFERENCES organizations (id),
  status         text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'shortlisted', 'accepted', 'rejected', 'withdrawn')),
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  currency       char(3) NOT NULL DEFAULT 'INR',
  valid_until    date,
  notes          text CHECK (notes IS NULL OR length(notes) <= 1000),
  submitted_by   uuid REFERENCES users (id),
  shortlisted_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- one live quote per inquiry; a vendor revises by withdrawing and quoting again
CREATE UNIQUE INDEX quotes_one_live_idx ON quotes (inquiry_id) WHERE status IN ('submitted', 'shortlisted', 'accepted');
CREATE INDEX quotes_request_idx ON quotes (request_id, status);
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quote_line_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organizations (id),
  quote_id    uuid NOT NULL REFERENCES quotes (id),
  position    integer NOT NULL DEFAULT 0,
  kind        text NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'travel', 'equipment', 'tax', 'other')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10000),
  unit_minor  bigint NOT NULL CHECK (unit_minor >= 0)
);
CREATE INDEX quote_line_items_quote_idx ON quote_line_items (quote_id, position);
CREATE TRIGGER quote_line_items_immutable BEFORE UPDATE OR DELETE ON quote_line_items FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations (id),
  request_id          uuid NOT NULL REFERENCES requests (id),
  quote_id            uuid NOT NULL REFERENCES quotes (id),
  vendor_id           uuid NOT NULL REFERENCES organizations (id),
  status              text NOT NULL DEFAULT 'pending_vendor' CHECK (status IN ('pending_vendor', 'confirmed', 'completed', 'cancelled')),
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  venue_text          text CHECK (venue_text IS NULL OR length(venue_text) <= 200),
  agreed_total_minor  bigint NOT NULL CHECK (agreed_total_minor >= 0),
  currency            char(3) NOT NULL DEFAULT 'INR',
  vendor_confirmed_at timestamptz,
  vendor_confirmed_by uuid REFERENCES users (id),
  confirmed_at        timestamptz,
  confirmed_by        uuid REFERENCES users (id),
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start)
);
CREATE UNIQUE INDEX bookings_one_live_idx ON bookings (request_id) WHERE status <> 'cancelled';
CREATE INDEX bookings_vendor_idx ON bookings (vendor_id, status);
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['request_matches', 'inquiries', 'quotes', 'quote_line_items', 'bookings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Matches: operations only.
CREATE POLICY request_matches_platform ON request_matches FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, DELETE ON request_matches TO kidos_app;

-- Inquiries: operations create and withdraw; the addressed vendor reads them and may only answer (decline or quote).
CREATE POLICY inquiries_select ON inquiries FOR SELECT
  USING (app_is_platform() OR (vendor_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['inquiries.respond'])));
CREATE POLICY inquiries_insert ON inquiries FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY inquiries_update ON inquiries FOR UPDATE
  USING (app_is_platform() OR (vendor_id = app_tenant_id() AND status = 'sent' AND app_has_permission('inquiries.respond')))
  WITH CHECK (app_is_platform() OR (vendor_id = app_tenant_id() AND status IN ('declined', 'quoted')));
GRANT SELECT, INSERT ON inquiries TO kidos_app;
GRANT UPDATE (status, decline_reason, responded_at) ON inquiries TO kidos_app;

-- Quotes: the vendor's own, anything for operations, and (to the family) only those operations offered or the one they accepted.
CREATE POLICY quotes_select ON quotes FOR SELECT
  USING (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['quotes.create', 'inquiries.respond']))
    OR (tenant_id = app_tenant_id() AND status IN ('shortlisted', 'accepted')
        AND EXISTS (SELECT 1 FROM requests r WHERE r.id = quotes.request_id AND r.requester_id = app_user_id()))
  );
CREATE POLICY quotes_insert ON quotes FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status = 'submitted' AND app_has_permission('quotes.create')
        AND EXISTS (SELECT 1 FROM inquiries i WHERE i.id = quotes.inquiry_id AND i.vendor_id = quotes.vendor_id AND i.tenant_id = quotes.tenant_id
                       AND i.request_id = quotes.request_id AND i.status IN ('sent', 'quoted')))
  );
CREATE POLICY quotes_update ON quotes FOR UPDATE
  USING (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status = 'submitted' AND app_has_permission('quotes.create'))
    OR (tenant_id = app_tenant_id() AND status = 'shortlisted' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = quotes.request_id AND r.requester_id = app_user_id()))
  )
  WITH CHECK (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status = 'withdrawn')
    OR (tenant_id = app_tenant_id() AND status = 'accepted')
  );
GRANT SELECT, INSERT ON quotes TO kidos_app;
GRANT UPDATE (status, shortlisted_at, updated_at) ON quotes TO kidos_app;

CREATE POLICY quote_line_items_select ON quote_line_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_line_items.quote_id));
CREATE POLICY quote_line_items_insert ON quote_line_items FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_line_items.quote_id AND q.tenant_id = quote_line_items.tenant_id
                  AND q.vendor_id = app_tenant_id() AND q.status = 'submitted' AND app_has_permission('quotes.create'))
  );
GRANT SELECT, INSERT ON quote_line_items TO kidos_app;

-- Bookings: created by the family when they accept an offered quote (or by operations); the vendor sees and answers its own.
CREATE POLICY bookings_select ON bookings FOR SELECT
  USING (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND app_ctx_has_any_permission(ARRAY['inquiries.respond', 'bookings.complete']))
    OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = bookings.request_id AND r.requester_id = app_user_id()))
  );
CREATE POLICY bookings_insert ON bookings FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (tenant_id = app_tenant_id() AND status = 'pending_vendor'
        AND EXISTS (SELECT 1 FROM requests r WHERE r.id = bookings.request_id AND r.requester_id = app_user_id() AND r.status = 'booking_pending')
        AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = bookings.quote_id AND q.request_id = bookings.request_id AND q.vendor_id = bookings.vendor_id
                       AND q.total_minor = bookings.agreed_total_minor AND q.status = 'accepted'))
  );
CREATE POLICY bookings_update ON bookings FOR UPDATE
  USING (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status = 'pending_vendor' AND app_has_permission('inquiries.respond'))
    OR (tenant_id = app_tenant_id() AND status = 'pending_vendor' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = bookings.request_id AND r.requester_id = app_user_id()))
  )
  WITH CHECK (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status IN ('pending_vendor', 'cancelled'))
    OR (tenant_id = app_tenant_id() AND status = 'cancelled')
  );
GRANT SELECT, INSERT ON bookings TO kidos_app;
GRANT UPDATE (status, scheduled_start, scheduled_end, venue_text, vendor_confirmed_at, vendor_confirmed_by, confirmed_at, confirmed_by, completed_at, cancelled_at, cancel_reason, updated_at) ON bookings TO kidos_app;

-- ---------------------------------------------------------------------------
-- What each actor may change on a booking, and the order of its life, enforced by the database
-- ---------------------------------------------------------------------------
CREATE FUNCTION bookings_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  platform boolean := app_is_platform();
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.agreed_total_minor IS DISTINCT FROM OLD.agreed_total_minor OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the parties and the agreed price of a booking cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'a % booking cannot change', OLD.status USING ERRCODE = '42501';
  END IF;

  -- Only operations decide the schedule and the later steps.
  IF NOT platform AND (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
       OR NEW.venue_text IS DISTINCT FROM OLD.venue_text OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'only operations can change the schedule or confirm a booking' USING ERRCODE = '42501';
  END IF;

  -- A vendor confirms what has been scheduled, as themselves.
  IF NEW.vendor_confirmed_at IS DISTINCT FROM OLD.vendor_confirmed_at OR NEW.vendor_confirmed_by IS DISTINCT FROM OLD.vendor_confirmed_by THEN
    IF NEW.scheduled_start IS NULL THEN
      RAISE EXCEPTION 'a booking can be confirmed by the vendor only once it has a date' USING ERRCODE = '23514';
    END IF;
    IF NEW.vendor_confirmed_by IS DISTINCT FROM app_user_id() AND NOT platform THEN
      RAISE EXCEPTION 'a vendor confirmation must be made by the person confirming' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'confirmed' THEN
      IF OLD.status <> 'pending_vendor' OR NOT platform OR NOT app_ctx_has_any_permission(ARRAY['bookings.confirm']) THEN
        RAISE EXCEPTION 'this booking cannot be confirmed by this person now' USING ERRCODE = '42501';
      END IF;
      IF NEW.vendor_confirmed_at IS NULL OR NEW.scheduled_start IS NULL THEN
        RAISE EXCEPTION 'the vendor must confirm a scheduled booking first' USING ERRCODE = '23514';
      END IF;
      NEW.confirmed_at := now();
      NEW.confirmed_by := app_user_id();
    ELSIF NEW.status = 'completed' THEN
      IF OLD.status <> 'confirmed' OR NOT platform OR NOT app_ctx_has_any_permission(ARRAY['bookings.complete']) THEN
        RAISE EXCEPTION 'only a confirmed booking can be completed, by operations' USING ERRCODE = '42501';
      END IF;
      NEW.completed_at := now();
    ELSIF NEW.status = 'cancelled' THEN
      IF platform AND OLD.status = 'confirmed' AND NOT app_ctx_has_any_permission(ARRAY['bookings.cancel']) THEN
        RAISE EXCEPTION 'cancelling a confirmed booking needs bookings.cancel' USING ERRCODE = '42501';
      END IF;
      IF NOT platform AND OLD.status <> 'pending_vendor' THEN
        RAISE EXCEPTION 'only operations can cancel a confirmed booking' USING ERRCODE = '42501';
      END IF;
      IF length(btrim(COALESCE(NEW.cancel_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'a reason is required to cancel a booking' USING ERRCODE = '23514';
      END IF;
      NEW.cancelled_at := now();
    ELSE
      RAISE EXCEPTION 'a booking cannot move to %', NEW.status USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bookings_a_enforce BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_enforce();
