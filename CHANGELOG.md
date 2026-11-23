# Changelog

Format: newest first. No release has been deployed yet; entries describe what exists in the repository.

## Home page: animated "journey at a glance"

- Asked for by the founder: an animated flow on the home page so visitors understand how it works.
- Added: `JourneyPlayer` above the five numbered steps. Five stops on a track (Ask, Match, Compare, Book, Enjoy), a marker that travels from one to the next about every 4.5 seconds, and a card for the current step that says who is involved (You, Our team, Providers) and what each one does. The words come from the same `JOURNEY` data as the numbered story below, so the two cannot disagree.
- Controls and accessibility: it moves only while it is on screen; pressing a step shows that step and stops it; a "Pause the tour" / "Play the tour" button is always there (WCAG 2.2.2); it does not play for people who ask their device for less motion (they step through it themselves and see no pause button); the stops are real buttons named in full for a screen reader; the track is decoration (`aria-hidden`); who is involved is also said in words, not only by style; changes are announced only when the visitor is stepping through. Movement is by transform only (no fading text), so contrast scans are not affected.
- Changed: `FlowStep` has an optional `short` label (set for the five home-page steps). New `k-journey*` styles in `packages/ui/src/styles.css`, tokens only, light and dark.
- Found, not mine: two older browser tests on the public pages fail on a build that includes the other session's work: the home steps test counts every list item inside the steps list (15, because each step now has a nested "who does what" list) and the safety page test finds the danger text twice. Both tests fixed afterwards: the steps test now counts only the five top-level steps, and the safety test looks inside the page's own content (the site footer repeats the danger line on every page). The page code was right; the tests were stale.

## Pictures: photo slots, with drawn stand-ins

- Asked for by the founder: real pictures of people, families, mums and children, not drawings ("not animation pictures"). The assistant cannot create photographs, so the founder supplies them (licensed, with permission from the people pictured).
- Added: nine named photo slots. A file named after a slot in `apps/web/public/photos/` replaces the drawing everywhere that slot is used (home page, steps, sign in, register, signed-in Home, empty states, not found). `docs/PHOTOS.md` lists every slot, shape and size. A photo is cropped to a set shape, loaded lazily (the top picture first), decorative and hidden from screen readers.
- Added: a permission record is required for every photo in `apps/web/photo-credits.json` (outside the public folder); a test fails without one, or when a file is over 400 KB or is not a known slot.
- Added: friendly drawn stand-ins (nine scenes of made-up people) as one `Illustration` component, used until a photo arrives; colours from new `--k-art-*` tokens that follow light and dark. `NEXT_PUBLIC_ARTWORK_FALLBACK=none` shows nothing instead. Not placed on safety, concerns, payments or operations screens.
- Fixed while building: the drawings first caused a React hydration warning (the server and the browser compute trigonometry to different last digits); every computed coordinate is now rounded and a test enforces it. Also removed a second "Create your account" button I had added to the home page, which made the existing test's link lookup ambiguous.
- Changed: `EmptyState` takes an optional `art`; the Vitest config has an `@` alias for the web app. New `.claude/launch.json` to start the stack and web app from the app (the documented `dev:web` script does not run on this machine: 'next' is not found at the repository root).
- Nine photographs are included, picked from Pexels at the founder's request ("pick from free sites and find HD photos") and approved by the founder file by file: cropped to each slot, resized to 1000 to 1800 px wide, hidden metadata removed, each under 400 KB. Pexels' licence allows commercial use without credit but gives no model release, so the people pictured have not given their own permission; every record says so, and the photos should be replaced with consented ones before any wide public launch (`docs/PHOTOS.md`, `LAUNCH_READINESS.md` B12). Two first picks were rejected on inspection (a misread id that turned out to be a statue, and a photo that could read as a mother ignoring her child) and replaced.

## Pilot go-live checklist: operations guide

- Added: `docs/OPERATIONS_GUIDE.md`, how the operations desk works the queue (daily round, every request step with its target and rules, matching, vendor onboarding, offline payments, concerns, reviews), written from the real screens and checked against the code. Not yet used by a person.

## Pilot go-live checklist: load check

- Added: `corepack pnpm@9.15.0 run check:load` (`tools/load-check.ts`): fills a throwaway database with about 30 times a pilot's data, signs in as real people, and times 25 screens (one caller, then eight at once) against a budget; it refuses to run if the seeded data does not reach the screens it times.
- Fixed: the platform audit trail (p95 6.9 s) and the operations request queue (p95 1.3 s) read every row; two indexes (migration 0017) bring them to about 55 ms and 60 ms. A test fails if either is missing.
- Known: the operations summary and "waiting for me" counts grow with the number of requests (about 0.3 s at 30,000); revisit before about 100,000. Not a capacity test and not run on a host.

## Phase 6.4: Safety concerns channel

- Added: **Report a concern** for families, community people and vendor people (also from every vendor page), under the emergency numbers 112 and 1098. A report goes to the platform team only: never to the vendor, the community or other families. Migration 0016.
- Added: the team's **Concerns** queue (child safety first, who reported, take on, decide with words the reporter reads), counted under "Waiting for you", with an email to the desk that something was reported (never what) and an email to the reporter that there is an update (never the outcome).
- Changed: `LAUNCH_READINESS.md` no longer claims a complaint route that did not exist; it states what the product does and does not do and makes the alert mailbox and a named person on duty launch requirements.
- Added: a public **Safety** page (`/safety`, in every footer, no sign-in) with the emergency numbers, who sees a report, a way in, and the team's email and phone from `NEXT_PUBLIC_SUPPORT_EMAIL` and `NEXT_PUBLIC_SUPPORT_PHONE` (validated; shown only when set).
- Added: the team's queue shows how long each report has waited and calls out a child-safety report that has waited a day or more.
- Known gaps: no chat or Reply-To, no automatic escalation of an unanswered report, no private notes or attachments on a report, and the in-app form needs a selected community or vendor (the public page is the way in otherwise).

## Phase 7 (first slice): Discovery catalog

- Added: **saved offerings**: a family saves an activity from the catalog or a vendor page and finds it again with "Only the activities I have saved". Private to the person (row-level security, no staff or vendor access), capped at 200. Migration 0015.
- Added: **ratings on every catalog card** (published reviews only) and **filters** for highest price and rating.
- Not built (deliberately): recommendations, sorting, per-community category enablement, events listing; see DEVELOPMENT_PROGRESS.md.
- Changed: the pilot launch checklist is no longer called Phase 7 (see the entry below).

## Pilot go-live checklist (started; not a numbered phase)

Note: first labelled "Phase 7" in error. Phase 7 in the master plan is the Discovery catalog; the real Phase 7 is the entry above.

- Added: `docs/LAUNCH_READINESS.md`: what blocks any real user (git host, hosting, email provider, legal review, secrets), the open founder decisions with the current default and a recommendation for each, the rehearsal and pilot plan, go/no-go criteria, a complaint and safety response template, a cost note.
- Changed: the CI workflow also builds the production API and runs the backup and restore drill (CI has never been executed: there is no git host yet).
- Changed: the deployment guide documents `OPS_ALERT_EMAIL` and adds smoke checks for applied migrations and a full-loop rehearsal.
- No application code changed. Still required before any real user: an email provider adapter (production refuses to start without one).

## Phase 6.3: Payments, reviews and notifications

- Added: **email notifications** through the provider-agnostic `Mailer`: a vendor's team is told of a request to quote, a date to confirm, a confirmed booking and a published review; a family of a question, approval, options ready, a proposed date, confirmation and a request to review; the operations desk (`OPS_ALERT_EMAIL`) of what only a family or vendor can trigger. Minimal content (a link, nothing private); sent after the action commits; a failing provider never breaks an action.
- Added: **"Waiting for you"** on the home page and `GET /me/attention`: what needs each person, derived from live state.
- Added: **offline payment records and the platform fee** (operations record, family and vendor see what concerns them, the family never sees the fee). Append-only. Migration 0014.
- Added: **reviews**: one per completed booking, written by the requester, moderated by operations before anyone else reads them, with a single vendor reply; the vendor page shows a rating and anonymous reviews.
- Fixed: the **stale-inquiry window**: a vendor can no longer quote on a request that has moved on (a trigger-maintained stage marker vendors can read), and its inbox reads "no longer needed".
- Changed: bookings carry payment summaries; a finished booking still refuses every change except operations setting the fee.

## Phase 6 (6.1 and 6.2): Matching, inquiries, quotes and booking

- Added: vendor matching with separate **eligibility** (identical to what families see in the catalog, re-checked when inquiries are sent) and a **score** with a reason for every point; manual additions with a logged reason. Migration 0013.
- Added: inquiries to up to five vendors at a time, carrying a snapshot of the request that never says who asked; the vendor's inbox (quote with line items, decline with a reason, withdraw and correct a quote); operations can capture a quote obtained by phone.
- Added: quote comparison and shortlisting, "offer these options to the family", the family choosing one (accepting, moving the request on and opening the booking in one step).
- Added: bookings: date and place set by operations, confirmed by the vendor, then by operations, then completed; cancellation with a reason; the database enforces who may change what and the order of a booking's life.
- Added: web screens: the sourcing workspace on the request page (matches with reasons, inquiries, quote comparison, booking), the vendor's Inquiries inbox and inquiry page, and the family's options and booking cards.
- Fixed (found by tests): manual matches could never be saved (an upsert needing a privilege the table deliberately lacks); a vendor's row lock hid non-open inquiries behind a 404 instead of an explanation; a bare status change could have let a family "accept" without a quote or booking.

## Phase 5: Requests and operations

- Added: families make requests in their community (three seeded request types with server-validated forms, shared fields for date, children, ages, budget and venue, and an optional link to a catalog offering). Migration 0012.
- Added: the operations workflow as data (statuses, allowed transitions with the permission each needs, notes, SLA targets), enforced by a database trigger that also records an append-only history: submitted, under review, information required, approved, with rejection, cancellation by the family and close-without-booking.
- Added: visibility by row-level security (family: own; community administrators: read their community's; platform: all), resident-visible messages versus internal notes, ownership (assign, take, unassign), SLA states (on track, due soon, overdue) for the operations clock only, and a queue summary.
- Added: web screens: My requests / Community requests / Request queue (one adaptive list with filters and summary tiles), Make a request (dynamic form), request detail (answers, messages, history, workflow actions), and an "Ask for this" link from the catalog.

## Phase 4 review: vetting stays current, vendor MFA

- Fixed (found by review, not by a failing test): a vendor whose required document expired after activation stayed visible to families. The catalog now fails closed on lapsed or missing vetting (migration 0011: `vendor_vetting_summary` kept in step with the documents by a trigger); the platform team can filter vendors by lapsed or expiring documents and vendors see a warning.
- Changed: vendor owners and administrators now require two-step verification.
- Added: caps of 100 documents and 200 offerings per vendor.
- Changed: the backup drill now supplies the `audit.read` permission and also proves the audit trail is hidden without it (it had gone stale after migration 0009).

## Phase 4: Vendors (operations-assisted)

- Added: vendor registration and onboarding workflow (draft, verification, active, suspended) with readiness checklists, history and per-step permissions; category tree; places served (communities or cities, travel fee); the vendor's own team with owner/administrator/staff limits. Migration 0010.
- Added: vetting: required documents as data, platform-only review, expiry handling, activation blocked until every required document is verified and current.
- Added: offerings with seven pricing models and whole-record validation, publish readiness rules; weekly availability and time off.
- Added: community approval of vendors, and the resident catalog (search, filters, vendor page) whose visibility is decided by row-level security.
- Added: web screens: Vendors (list, register, full vendor workspace with status, details, categories, places, documents, offerings, availability, team), Community vendors (approve, withdraw), Find services (catalog and vendor page); navigation for each audience.
- Fixed (found by tests): a PATCH of one offering field would have reset a published offering to draft (zod defaults applied to a partial schema).

## Phase 3.5: Hardening review of Phase 3

- Changed: reads are now least-privilege (users, memberships, role assignments, audit log, community private details, status history, invite codes). Community internal notes moved to a platform-only table. Suspended organizations are switched off for their own people. Migration 0009.

## Phase 3: Communities, membership and families

- Added: community registration and onboarding workflow (draft, verification, active, suspended) with readiness checklists and history; public directory of active communities; community administrators (assigned by the platform team); facilities; typed, validated community policies. Migration 0006.
- Added: invite codes (shown once, hashed, limited places), joining by code, requests to join with administrator approval, member management (approve, decline, suspend, reinstate, remove). Database policies now enforce who may create and change memberships and member roles. Migration 0007.
- Added: family profiles: children as guardian-owned profiles (nickname, birth year, interests), versioned consent, export, erasure; no access for staff. Migration 0008.
- Added: web screens for joining a community, family, communities list and registration, and full community management; platform mode switch; `TextAreaField`, `CheckboxField`, `FieldGroup`.
- Changed: `GET /me` returns `platformStaff`; shared keyset pagination helper.
- Fixed (found by tests): join race answered 500 instead of a clean refusal; status checklist stale after assigning an administrator; policy "Saved" confirmation lost; data tables unnamed for assistive technology; flaky contrast scan taken mid-transition.

## Phase 2: Foundation (in progress, gate report pending approval)

### Milestone 2.4: Production build and recovery
- Added: production bundle of the API (`build:api`), smoke-tested as a real process; backup and restore drill (`drill:backup`); `docs/DEPLOYMENT_GUIDE.md`.

### Milestone 2.3: Web shell and design system v0
- Added: design system (`packages/ui`): tokens for light and dark themes, reduced motion, 16 components, WCAG contrast tests.
- Added: Next.js web app: home, sign in, register, MFA step, forgot and reset password, email confirmation, signed-in home, security (MFA setup with QR code, recovery codes, password change, sessions), audit log, not-found and error pages.
- Added: permission-driven navigation, organization switcher, `/api` proxy, security headers.
- Added: Playwright end-to-end suite (57 tests, desktop and phone) with axe WCAG A and AA scans in both colour schemes; `tools/stack.ts` dev and e2e stack on embedded PostgreSQL.
- Fixed (found by tests): dark-theme destructive button contrast; show/hide password accessible name.

### Milestone 2.2b: MFA, email verification, password reset
- Added: TOTP MFA (RFC 6238 verified) with encrypted secrets, replay protection, recovery codes, lockout, pending-MFA sessions, role-driven requirement (`roles.requires_mfa`).
- Added: email verification, forgot and reset password, change password, per-account email cooldown, `Mailer` port.
- Changed: application database role can no longer update arbitrary `users` columns (migration 0005). Production now requires https for `APP_BASE_URL` and `ALLOWED_ORIGINS`.

### Milestone 2.2a: API and authentication core
- Added: Fastify API (ADR 0004), registration, login with lockout, server-side sessions, tenant switching with verified membership, permission guard, audit log, paginated audit endpoint, rate limits, CSRF origin checks. Migrations 0003 and 0004.
- Fixed (found by tests): fractional SQL intervals, audit write before tenant context, roles hidden without an active tenant, pagination losing rows (microsecond cursor precision).

### Milestone 2.1: Database foundation
- Added: pnpm monorepo, migration runner, tenancy, RBAC and audit schema with forced row-level security, seeded permission catalog (migrations 0001, 0002), isolation test suite, CI workflow.

## Phase 1: Product and architecture
- Added: requirements, architecture, database design, security, API conventions, UX, AI architecture, test plan, roadmap, metrics dictionary, ADR 0001 (MVP scope cut).

## Phase 0: Discovery
- Added: findings, risks, recommended architecture and plan (`docs/PHASE_0_FINDINGS.md`).
