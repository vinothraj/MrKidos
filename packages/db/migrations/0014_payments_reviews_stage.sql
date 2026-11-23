-- 0014 Phase 6.3: the request-stage marker, offline payment records and the platform fee, and reviews.
--
-- 1. STALE INQUIRIES. Vendors cannot read requests, so they could not know that a request had moved on (the family
--    chose someone else, or cancelled) and might still send a quote nobody will read. A tiny marker table that vendors
--    asked about the request CAN read, kept in step with the request by a trigger, closes that window: a vendor's quote
--    insert is refused once the request has moved past the asking stage. (Same pattern as vendor_vetting_summary.)
-- 2. PAYMENTS. Money moves offline (ADR 0001, assumption B): the family pays the vendor, and the vendor pays the
--    platform a fee. Operations RECORD what happened; nothing here moves money. Records are append-only.
-- 3. REVIEWS. Only the requester of a completed booking, once, moderated by operations before anyone else can read it,
--    with one reply from the vendor.

-- ---------------------------------------------------------------------------
-- 1. Request stage marker
-- ---------------------------------------------------------------------------
CREATE TABLE request_stage_flags (
  request_id uuid PRIMARY KEY REFERENCES requests (id),
  tenant_id  uuid NOT NULL REFERENCES organizations (id),
  -- true once vendors should no longer be quoting: the options have been offered, or the request is decided or finished
  closed     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE request_stage_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_stage_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY request_stage_flags_select ON request_stage_flags FOR SELECT
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM inquiries i WHERE i.request_id = request_stage_flags.request_id)
    OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_stage_flags.request_id))
  );
-- Written by whoever changes the request (the requester or operations), through the trigger below.
CREATE POLICY request_stage_flags_insert ON request_stage_flags FOR INSERT
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_stage_flags.request_id AND r.requester_id = app_user_id())));
CREATE POLICY request_stage_flags_update ON request_stage_flags FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_stage_flags.request_id AND r.requester_id = app_user_id())))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant_id() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_stage_flags.request_id AND r.requester_id = app_user_id())));
GRANT SELECT, INSERT ON request_stage_flags TO kidos_app;
GRANT UPDATE (closed, updated_at) ON request_stage_flags TO kidos_app;

CREATE FUNCTION requests_sync_stage_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_closed boolean := NEW.status NOT IN ('draft', 'submitted', 'under_review', 'information_required', 'approved', 'sourcing', 'vendor_inquiry', 'quotes_received');
BEGIN
  INSERT INTO request_stage_flags (request_id, tenant_id, closed) VALUES (NEW.id, NEW.tenant_id, is_closed)
  ON CONFLICT (request_id) DO UPDATE SET closed = EXCLUDED.closed, updated_at = now();
  RETURN NULL;
END
$$;
CREATE TRIGGER requests_c_sync_stage_flag AFTER INSERT OR UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION requests_sync_stage_flag();

-- existing requests (development databases)
INSERT INTO request_stage_flags (request_id, tenant_id, closed)
SELECT id, tenant_id, status NOT IN ('draft', 'submitted', 'under_review', 'information_required', 'approved', 'sourcing', 'vendor_inquiry', 'quotes_received') FROM requests;

-- A vendor can no longer quote once the request has moved past the asking stage.
DROP POLICY quotes_insert ON quotes;
CREATE POLICY quotes_insert ON quotes FOR INSERT
  WITH CHECK (
    app_is_platform()
    OR (vendor_id = app_tenant_id() AND status = 'submitted' AND app_has_permission('quotes.create')
        AND NOT EXISTS (SELECT 1 FROM request_stage_flags f WHERE f.request_id = quotes.request_id AND f.closed)
        AND EXISTS (SELECT 1 FROM inquiries i WHERE i.id = quotes.inquiry_id AND i.vendor_id = quotes.vendor_id AND i.tenant_id = quotes.tenant_id
                       AND i.request_id = quotes.request_id AND i.status IN ('sent', 'quoted')))
  );

-- ---------------------------------------------------------------------------
-- 2. Offline payments and the platform fee
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN platform_fee_minor bigint CHECK (platform_fee_minor IS NULL OR platform_fee_minor >= 0);
GRANT UPDATE (platform_fee_minor) ON bookings TO kidos_app;

CREATE TABLE booking_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organizations (id),
  booking_id   uuid NOT NULL REFERENCES bookings (id),
  -- who paid whom: the family paid the vendor, or the vendor paid the platform its fee
  kind         text NOT NULL CHECK (kind IN ('family_to_vendor', 'vendor_to_platform')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency     char(3) NOT NULL DEFAULT 'INR',
  method       text NOT NULL CHECK (method IN ('cash', 'upi', 'bank_transfer', 'card_offline', 'other')),
  reference    text CHECK (reference IS NULL OR length(reference) <= 100),
  paid_on      date NOT NULL,
  note         text CHECK (note IS NULL OR length(note) <= 300),
  recorded_by  uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_payments_booking_idx ON booking_payments (booking_id, created_at);
CREATE TRIGGER booking_payments_immutable BEFORE UPDATE OR DELETE ON booking_payments FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
ALTER TABLE booking_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_payments FORCE ROW LEVEL SECURITY;
-- Operations see everything. The family sees what they paid; the vendor sees both its payments and its fee. Nobody else.
CREATE POLICY booking_payments_select ON booking_payments FOR SELECT
  USING (
    app_is_platform()
    OR (kind = 'family_to_vendor' AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_payments.booking_id))
    OR (kind = 'vendor_to_platform' AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_payments.booking_id AND b.vendor_id = app_tenant_id()))
  );
CREATE POLICY booking_payments_insert ON booking_payments FOR INSERT WITH CHECK (app_is_platform());
GRANT SELECT, INSERT ON booking_payments TO kidos_app;

-- The booking rules of 0013, plus: only operations set the platform fee.
CREATE OR REPLACE FUNCTION bookings_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  platform boolean := app_is_platform();
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.agreed_total_minor IS DISTINCT FROM OLD.agreed_total_minor OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the parties and the agreed price of a booking cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.platform_fee_minor IS DISTINCT FROM OLD.platform_fee_minor THEN
    IF NOT platform OR NOT app_ctx_has_any_permission(ARRAY['payments.record']) THEN
      RAISE EXCEPTION 'only operations can set the platform fee' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'a % booking cannot change', OLD.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
       OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end OR NEW.venue_text IS DISTINCT FROM OLD.venue_text OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR NEW.vendor_confirmed_at IS DISTINCT FROM OLD.vendor_confirmed_at) THEN
    RAISE EXCEPTION 'a % booking cannot change', OLD.status USING ERRCODE = '42501';
  END IF;

  IF NOT platform AND (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
       OR NEW.venue_text IS DISTINCT FROM OLD.venue_text OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'only operations can change the schedule or confirm a booking' USING ERRCODE = '42501';
  END IF;

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

-- ---------------------------------------------------------------------------
-- 3. Reviews
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),       -- the community
  booking_id      uuid NOT NULL UNIQUE REFERENCES bookings (id),     -- one review per booking
  vendor_id       uuid NOT NULL REFERENCES organizations (id),
  requester_id    uuid NOT NULL REFERENCES users (id),
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            text CHECK (body IS NULL OR length(body) <= 1000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  moderated_by    uuid REFERENCES users (id),
  moderated_at    timestamptz,
  moderation_note text CHECK (moderation_note IS NULL OR length(moderation_note) <= 300),
  vendor_reply    text CHECK (vendor_reply IS NULL OR length(btrim(vendor_reply)) BETWEEN 1 AND 1000),
  replied_by      uuid REFERENCES users (id),
  replied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_vendor_idx ON reviews (vendor_id, status, created_at DESC);
CREATE INDEX reviews_queue_idx ON reviews (status, created_at) WHERE status = 'pending';
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;

-- The author always sees their own review. Others see it only once operations published it, and only if they could see the vendor.
CREATE POLICY reviews_select ON reviews FOR SELECT
  USING (
    app_is_platform()
    OR requester_id = app_user_id()
    OR (status = 'published' AND EXISTS (SELECT 1 FROM organizations v WHERE v.id = reviews.vendor_id))
  );
CREATE POLICY reviews_insert ON reviews FOR INSERT
  WITH CHECK (
    tenant_id = app_tenant_id() AND requester_id = app_user_id() AND status = 'pending' AND app_has_permission('reviews.create')
    AND EXISTS (SELECT 1 FROM bookings b JOIN requests r ON r.id = b.request_id
                 WHERE b.id = reviews.booking_id AND b.status = 'completed' AND b.vendor_id = reviews.vendor_id AND b.tenant_id = reviews.tenant_id AND r.requester_id = app_user_id())
  );
CREATE POLICY reviews_update ON reviews FOR UPDATE
  USING (app_is_platform() OR (vendor_id = app_tenant_id() AND status = 'published' AND app_has_permission('reviews.reply')))
  WITH CHECK (app_is_platform() OR (vendor_id = app_tenant_id() AND status = 'published'));
GRANT SELECT, INSERT ON reviews TO kidos_app;
GRANT UPDATE (status, moderated_by, moderated_at, moderation_note, vendor_reply, replied_by, replied_at) ON reviews TO kidos_app;

CREATE FUNCTION reviews_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  platform boolean := app_is_platform();
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id OR NEW.rating IS DISTINCT FROM OLD.rating OR NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'what a review says cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.moderation_note IS DISTINCT FROM OLD.moderation_note THEN
    IF NOT platform OR NOT app_ctx_has_any_permission(ARRAY['reviews.moderate']) THEN
      RAISE EXCEPTION 'only moderators can decide on a review' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'rejected' OR NEW.status = 'pending' THEN
        RAISE EXCEPTION 'a review cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
      END IF;
      IF NEW.status = 'rejected' AND length(btrim(COALESCE(NEW.moderation_note, ''))) = 0 THEN
        RAISE EXCEPTION 'say why the review is not published' USING ERRCODE = '23514';
      END IF;
      NEW.moderated_by := app_user_id();
      NEW.moderated_at := now();
    END IF;
  END IF;

  IF NEW.vendor_reply IS DISTINCT FROM OLD.vendor_reply OR NEW.replied_by IS DISTINCT FROM OLD.replied_by OR NEW.replied_at IS DISTINCT FROM OLD.replied_at THEN
    IF OLD.vendor_reply IS NOT NULL THEN
      RAISE EXCEPTION 'a review already has a reply' USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'published' THEN
      RAISE EXCEPTION 'only a published review can be answered' USING ERRCODE = '42501';
    END IF;
    IF NOT platform AND NOT app_has_permission('reviews.reply') THEN
      RAISE EXCEPTION 'replying needs the reviews.reply permission' USING ERRCODE = '42501';
    END IF;
    NEW.replied_by := app_user_id();
    NEW.replied_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reviews_a_enforce BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION reviews_enforce();
