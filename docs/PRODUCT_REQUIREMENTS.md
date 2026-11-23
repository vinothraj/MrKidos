# Product Requirements (Pilot MVP baseline)

Scope baseline: ADR 0001. Priority: **M** = must for pilot, **S** = should (if time), **C** = could, **P** = post-pilot.

## 1. Vision and positioning
A Community Experience & Commerce Network. Start with Kids & Family Experiences in gated communities and apartment townships. Architecture and data model are category-agnostic. Positioning line (editable): "Discover More. Experience More. Together."

## 2. Personas

| Persona | Goals | Pain today | Key needs |
|---|---|---|---|
| **Priya, resident parent** | Find safe, good activities for kids; avoid chasing vendors on WhatsApp | Unknown vendor quality, scattered recommendations | Simple request form on phone, clear status, trusted vendors, reviews |
| **Ramesh, community admin (volunteer)** | Keep residents engaged without extra work or risk | Vendor safety, disputes, admin burden | Approve vendors/events quickly, see what is happening, enforce rules |
| **Anita, vendor (magician, workshop provider)** | Steady bookings with fair pay | Unreliable lead flow, price haggling | Clear inquiries, easy quoting, calendar, timely payment info |
| **Founder / Ops coordinator** | Turn requests into confirmed bookings quickly | Manual calling, tracking in spreadsheets | Queue, shortlist, multi-vendor inquiry, quote comparison, notes, SLAs |
| **Platform admin** | Safe, compliant operation | Mixed permissions, audit needs | Role management, audit log, vetting records |

## 3. Core user journeys (pilot)

**J1 Resident request to review**
Register, verify contact, join community (invite code or admin approval), add family, submit request (dynamic form), receive status updates, view quotes or confirmation, attend, review.

**J2 Operations: request to booking**
New request lands in queue, review, clarify (resident-visible), approve, get match shortlist with reasons, send inquiry to 3 to 5 vendors, collect availability and quotes, compare, shortlist, get community approval if policy requires, confirm booking, coordinate, mark complete, record offline payment status and fee.

**J3 Vendor**
Ops creates vendor profile and invites contact, vendor logs in, reviews inquiry, responds (available/not, quote with line items), receives booking confirmation, marks delivery complete, sees review.

**J4 Community admin**
Receive vendor/event approval tasks, approve or reject with reason, view community requests and bookings.

## 4. Functional requirements

### Identity and access
- FR-ID-1 (M) Register, sign in, sign out, password reset, email verification, phone verification readiness
- FR-ID-2 (M) Session management with device list and revoke
- FR-ID-3 (M) MFA (TOTP) mandatory for platform, ops, finance, community admin roles
- FR-ID-4 (M) Users can hold roles in multiple tenants and switch context
- FR-ID-5 (M) Roles, permissions and assignments stored in DB; seeded roles from the brief; code checks permissions only
- FR-ID-6 (S) Basic role-assignment admin UI

### Communities and membership
- FR-CM-1 (M) Ops creates community with profile, location, facilities/venues, rules, policies
- FR-CM-2 (M) Community states: draft, verification, active, suspended
- FR-CM-3 (M) Resident join via invite code or admin approval (per community setting)
- FR-CM-4 (M) Community policy flags: vendor approval required, event approval required, vendor entry requirements
- FR-CM-5 (P) Community branding/theme, custom workflows, revenue-share configuration UI

### Families
- FR-FM-1 (M) Guardian creates family, adds children with minimal data (nickname, age band or year of birth, interests)
- FR-FM-2 (M) Privacy settings; export and deletion request flow
- FR-FM-3 (M) Children never have accounts

### Vendors (ops-assisted)
- FR-VN-1 (M) Ops creates vendor with profile, categories, service areas, travel radius and fee, portfolio media, documents
- FR-VN-2 (M) Vetting checklist with document records and expiry; status draft, in review, approved, suspended
- FR-VN-3 (M) Vendor-community approval (when community policy requires)
- FR-VN-4 (M) Vendor staff login with limited self-service (respond to inquiries, quotes, calendar, limited profile edits)
- FR-VN-5 (M) Offerings with packages, pricing model, duration, participants, age group, requirements, cancellation policy
- FR-VN-6 (M) Vendor availability (calendar blocks and recurring rules)
- FR-VN-7 (P) Self-serve onboarding wizard, vendor subscriptions, promoted listings

### Catalog and discovery
- FR-DC-1 (M) Category and subcategory tree (data), per-community enablement
- FR-DC-2 (M) Resident browse and search of offerings; filters: category, age group, price, community coverage
- FR-DC-3 (S) Favorites
- FR-DC-4 (P) Personalized recommendations, indoor/outdoor, rating filters

### Requests and workflow
- FR-RQ-1 (M) Per-category dynamic request form (versioned JSON schema), server-validated
- FR-RQ-2 (M) Default workflow seeded: Draft, Submitted, Under Review, Information Required, Approved, Sourcing, Vendor Inquiry, Quotes Received, Shortlisted, Community Approval, Booking Pending, Confirmed, Scheduled, In Progress, Completed, Cancelled, Rejected, Closed
- FR-RQ-3 (M) Transition permissions, append-only status history, resident-visible comments versus internal notes
- FR-RQ-4 (M) Attachments with secure upload
- FR-RQ-5 (M) SLA timers per status and escalation flag
- FR-RQ-6 (M) Resident tracking page and notifications
- FR-RQ-7 (P) Workflow and form admin UI

### Operations workspace
- FR-OP-1 (M) Queue with filters, saved views, sort, pagination
- FR-OP-2 (M) Request detail: requirements, timeline, notes, attachments, tasks
- FR-OP-3 (M) Vendor match shortlist with score and reasons; manual override and logged reason
- FR-OP-4 (M) Multi-vendor inquiry with message templates; response tracking
- FR-OP-5 (M) Quote capture (line items, taxes, travel), side-by-side comparison
- FR-OP-6 (M) Booking confirmation and completion; cancellation with reason
- FR-OP-7 (S) Board (kanban) view and calendar view
- FR-OP-8 (M) Offline payment tracking: amount due, paid, platform fee, status (no gateway)

### Reviews
- FR-RV-1 (M) Review allowed only after completed booking; moderation queue
- FR-RV-2 (M) Vendor reply

### Notifications
- FR-NT-1 (M) In-app notification center with unread state
- FR-NT-2 (M) Email via provider adapter with template, retry, delivery log
- FR-NT-3 (M) User notification preferences
- FR-NT-4 (P) Push, SMS, WhatsApp (adapter interface now, operations later)

### Audit and admin
- FR-AU-1 (M) Append-only audit for security-relevant and business-critical actions
- FR-AU-2 (M) Support "view as" with explicit audit (S)
- FR-AD-1 (M) Basic admin screens: communities, vendors, categories, users and roles

### Out of MVP (explicit)
Online payments, product commerce, events module, rentals, AI features (request assistant optional only if time permits after Phase 6), analytics beyond ops dashboard counts, native apps, multi-language UI, seasonal themes, visual workflow builder, SMS/WhatsApp sending.

## 5. Non-functional requirements (targets)

| Area | Target |
|---|---|
| Performance | Resident pages: LCP under 2.5 s on mid-range Android over 4G; API p95 under 500 ms for typical reads |
| Availability | 99.5% monthly (pilot); documented maintenance windows |
| Recovery | RPO 24 h or better (daily backups, point-in-time if offered), RTO 4 h; restore drill before go-live |
| Security | OWASP ASVS Level 2 as target baseline for auth, session, access control |
| Accessibility | WCAG 2.2 AA target; axe checks in CI plus manual keyboard pass per feature |
| Privacy | Data minimization for children; consent records; deletion/export flows; DPDP alignment (legal review pending) |
| Isolation | Zero cross-tenant reads/writes proven by automated tests on every tenant-owned table |
| Observability | Structured logs with correlation ID; error tracking; job queue visibility |
| Browser support | Last two versions of Chrome, Safari, Edge, Firefox; Android Chrome and iOS Safari |
| Scale (design) | Comfortable to 50 communities, 50k residents, 500 vendors on a single database before re-architecture |

## 6. Domain separation reminder
Experience/Service, Request, Event, Rental, Product are separate modules sharing only infrastructure (media, pricing rules, notifications, audit). MVP builds Experience/Service and Request; others only reserve boundaries.

## 7. Open questions
See `DEVELOPMENT_PROGRESS.md`.
