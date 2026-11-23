# Security, Privacy and Child Safety

Baseline: OWASP ASVS Level 2 (target), OWASP Top 10. Status: design (no code yet).

## 1. Security principles
Deny by default; authorize on the server for every request; minimize data collected; log security events; least privilege for people, services and database roles; secrets never in code or logs.

## 2. Threat model (STRIDE summary of MVP flows)

| Flow | Threat | Control |
|---|---|---|
| Login | Credential stuffing, brute force (S) | Argon2id, rate limit per IP and account, progressive delay, breach-password check, MFA for staff |
| Session | Fixation, theft (S, E) | Rotate on login and privilege change, HttpOnly Secure SameSite cookies, idle and absolute timeouts, device list, revoke |
| Any API | Broken access control (E, I) | Permission guard on every route, RLS, object-level checks, automated authorization matrix tests |
| Tenant data | Cross-tenant leakage (I) | RLS plus tenant-scoped repositories, CI leakage suite on all tables |
| Forms | Injection, XSS (T) | Parameterized queries, schema validation, output encoding, strict CSP, no raw HTML rendering of user text |
| Uploads | Malware, type spoofing, path traversal (T, D) | Content sniffing, allow-list types, size caps, random keys, private storage, scan hook, image re-encoding |
| Status changes | Unauthorized or tampered transitions (T, R) | Transition permission checks in one service, append-only history, audit |
| Vendor contact | Disintermediation, harassment (I) | Contact reveal only after confirmed booking, report/block, moderation |
| Reviews | Fake or abusive content (T) | Reviews only after completed booking, moderation queue |
| Admin actions | Insider misuse (R) | Audit log, MFA, "view as" is explicit and audited, least-privilege roles |
| Notifications | Phishing via templates, data leakage (S, I) | Template allow-listed fields, no sensitive data in email bodies |
| AI (later) | Prompt injection, data exfiltration (T, I) | No write tools, user text untrusted, human confirm, redaction, children's data excluded |
| Availability | Abuse, DoS (D) | Rate limits, request size limits, queue backpressure, pagination caps |

## 3. Child safety and privacy
- Minors have no accounts. Guardians create child profiles with nickname, age band or birth year, and interests only. No photos, school, address or contact data.
- Child data is never shown to vendors beyond what a request needs (e.g. age group and headcount), never used in public content, never sent to AI providers by default.
- Consent records stored for guardian consent, privacy notice version and marketing opt-ins.
- Vendors who work with children need a configurable vetting checklist (identity verification, background-check attestation, references, safety training, insurance where relevant) with expiry and reviewer.
- Safety-sensitive categories (rides, inflatables, water, fire, food, animals, high-activity sports) trigger additional required documents and community approval by policy.
- Reporting channel for safety concerns with a documented response process (founder-owned for pilot). **Built in migration 0016 (see "Concerns" below); the response process is in `LAUNCH_READINESS.md` section 5.1 and still needs a named person on duty and legal review.**
- Data subject rights: export, correction and deletion workflows; retention schedule defined in Phase 3.
- Legal review required before launch (DPDP Act obligations for children's data, vendor contracts, GST on fees, event liability). Not legal advice.

## 4. Authentication and session
Email plus password (Argon2id with tuned parameters), email verification, password reset with single-use short-lived tokens, optional phone verification readiness. TOTP MFA required for platform, ops, finance and community admin roles; recovery codes stored hashed. Sessions are server-side records referenced by an opaque cookie.

### Implemented and verified (Milestone 2.2a)
- Argon2id hashing (memory 19 MiB, 2 passes), password 12 to 128 characters, small common-password denylist.
- Opaque 256-bit session token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored; absolute (default 7 days) and idle (default 24 h) expiry; revocation on logout and per session.
- Account lockout after 5 failures (15 min, doubling every further 5, capped at 60 min); uniform error for unknown account and wrong password; constant-time-ish unknown-account path; failures audited without email or password.
- Per-IP rate limits (auth routes stricter). Set `TRUST_PROXY=true` behind a reverse proxy, otherwise all clients share the proxy's IP.
- CSRF: Origin allow-list for state-changing requests plus SameSite cookies.
- Strict request schemas (unknown properties rejected), request-size limit, helmet headers, `Cache-Control: no-store`, log redaction of cookies.
- Tenant context: membership verified on every request before the database context is set; platform scope needs `platform_staff` and platform-organization membership.
- Denied authorization attempts are written to the tenant's audit log.

### Implemented and verified (Milestone 2.2b)
- **TOTP MFA** (RFC 6238, verified against the RFC test vectors): 160-bit secrets encrypted at rest with AES-256-GCM bound to the user id; confirmation step before activation; one-step clock-drift window; replay protection (a time step is accepted once); 10 single-use recovery codes stored as hashes; lockout after repeated wrong codes; password plus current code required to disable.
- **Pending sessions:** after a password login for an MFA user the session is unusable (401 `mfa_required`) except to verify or log out. Enrolling ends all other sessions so no pre-MFA session survives.
- **Role-driven MFA:** `roles.requires_mfa` (data) is set for platform and community staff roles. Guarded routes return 403 `mfa_enrollment_required` until such a user enrolls; MFA cannot be disabled while such a role is held.
- **Email verification:** single-use, hashed, expiring (24 h) tokens; required before any permission-guarded action.
- **Password reset:** single-use, hashed, 1 h tokens; identical response whether or not the account exists; reset ends all sessions and clears lockout; does not bypass MFA; weak new passwords are rejected without consuming the token. Password change re-verifies the current password under the same lockout and ends other sessions.
- **Least privilege at the database:** the application role can update only named columns of `users`, `sessions`, `user_credentials`, `mfa_credentials`, `one_time_tokens`; it cannot change a user's email or status, session ownership, or token expiry.

### Communities, membership and family data (Phase 3)
- **Public versus private community data.** `community_profiles` (name, area, type, description) is what the directory shows; address, GPS, contacts and notes live in `community_private`, visible only to that community's members and platform staff. The directory lists ACTIVE communities only, and a suspended community disappears immediately.
- **Membership rules are enforced by the database, not only by code** (migration 0007). Row-level policies decide that: a stranger can create only their own *pending* membership in an *active* community; can create their own *active* membership only while presenting a *valid* invite code for that community (not revoked, not expired, places left); can never approve themselves (the only self-edit allowed is leaving); can receive only resident-level roles (`resident`, `parent_guardian`, `family_member`), and only for a membership that is already active; and that granting admin-level roles needs `roles.manage` or platform scope. Community administrators can approve members and grant resident roles but cannot grant admin roles to anyone. Tested directly against the database as an attacker would (self-approval, joining a draft community, expired/revoked/used-up/foreign codes, un-revoking a code, self-granting `community_admin`).
- **Invite codes:** 50 random bits, shown once, stored only as a hash; per-session rate limiting on guessing; uses are counted atomically so a race for the last place admits exactly one person, and every failure returns the identical message so codes cannot be probed.
- **Administrators are managed by the platform team.** A community administrator cannot assign, remove, suspend or otherwise act on another administrator, nor on themselves.
- **Children's data (families, children, consents):** only the owning guardian can read or change it: there is deliberately no platform-staff or community policy, proven by a test that a super administrator in platform scope reads zero rows. Minimal fields (nickname, birth year, interests), no photo, school or contact data (nicknames that look like contact details are rejected), coarse age bands in responses, explicit versioned consent before the first child is stored, export of everything held, and hard-delete erasure that also withdraws consent. Audit records say something happened, never what the child's details are.
- **Narrow, deliberate exception to "the database trusts the tenant context":** the two join flows set a tenant context for a person who is not yet a member (to read one policy and insert one pending membership, or to use a valid code). The database policies above are what make that safe; the code is documented and tested, and `CLAUDE.md` keeps the rule that no other flow may do this.

### Least-privilege reads and suspended organizations (Milestone 3.5, migration 0009)
Row-level security first limited *writes*; a review found that *reads* were broader than needed. Now:
- `users`, `memberships`, `role_assignments`: you see your own rows; a person acting in a community sees that community's rows only if they hold a people-management permission. Ordinary residents can no longer list their neighbours.
- `audit_log` needs `audit.read`; `community_private`, status history and the invite-code list need the matching staff permission.
- **Platform-only internal notes** live in their own tables (`community_internal_notes`, `vendor_internal_notes`) whose only policy is platform scope, so even a community administrator or vendor owner cannot read them; the API also refuses writes (403 `platform_only_field`).
- Read policies use the verified permissions the API places in the request context (`app.permissions`, validated against a strict pattern, never from user input); write policies use the table-derived `app_has_permission`.
- **A suspended organization is switched off for its own people** (403 `tenant_suspended` on every route, cannot be selected in the UI); platform staff in platform scope are unaffected so they can investigate and reinstate.

### Vendors, vetting, offerings and the catalog (Phase 4, migration 0010)
- **A vendor is an organization**, so isolation between vendors is the same row-level security that separates communities; one vendor's team cannot read another's profile, documents, offerings, availability or team (tested by id, by route and by naming the other vendor as the acting tenant).
- **What residents can see is decided in the database, not in query filters.** An organization row of type `vendor` is visible to a resident only when the vendor is *active*, *serves the community the resident is acting in*, and the community has *approved it* (unless the community turned the `vendor_approval_required` policy off; the default is on, the safe choice for a children's platform). Vendor profiles, categories and *published* offerings are visible exactly when that organization row is visible, so there is one rule to get right. Tested at the database (12 tests) and through the API (approval, revocation, policy off, suspension, other communities, draft offerings).
- **Public versus private vendor data** is split like communities: `vendor_profiles` (name, tagline, description, area) is public once visible; legal name, registration number, contact details and address live in `vendor_private`, readable only by the vendor's own team with `vendors.read` and the platform team. Community approvers see only public details.
- **Vetting is the safety gate.** Activation is blocked until every *required* requirement (identity proof, background check, child-safety briefing) has a *verified, unexpired* document; the requirement list is data (`vetting_requirements`), so adding one needs no code change. Only the platform team can verify or reject (`vendors.vet`, platform scope), a rejection needs a reason, an expired document cannot be verified, and the database refuses a vendor inserting or editing a document that is already `verified`. Documents are records (title, reference, dates) with no file upload yet.
- **Owners are chosen by the platform team.** A vendor's owner can add administrators and staff but cannot create another owner (API rule and database policy), nobody can remove themself, and the last owner of an active vendor cannot be removed.
- Offerings are validated as a whole on every change (a PATCH is merged with the stored record and re-validated, so a partial update cannot break a rule such as price-required or maximum-at-least-minimum), and cannot be published until they have a description, a duration and a cancellation policy.
- **Known gap:** vendor roles do not require two-step verification (only platform and community staff roles do). Vendors handle documents and, later, children's activity details, so the founder should decide whether `vendor_owner` and `vendor_admin` should require it (a one-line data change in `roles.requires_mfa`).

### Requests and the operations workflow (Phase 5, migration 0012)
- **Visibility is row-level security.** A request is readable by its requester, by people holding `requests.read_community` in that community, and by the platform in platform scope. A neighbour in the same community, an administrator of another community, platform staff outside platform scope, and people with no community context read nothing (tested at the database and through the API; a foreign request is a 404, indistinguishable from a missing one).
- **Internal notes cannot reach a family or a community**: they are rows of `request_comments` with `visibility = 'internal'` that only platform scope can read, so no API bug can leak them. Transition notes (rejection reasons, questions) are deliberately visible to the family, and the UI says so; private remarks belong in internal notes.
- **The workflow is enforced by the database.** A trigger refuses a status change that is not a row of `workflow_transitions`, that the actor is not allowed to take (staff steps check the verified permission list; requester steps need the person to be the requester and hold the permission), or that lacks a required note. It restarts the target clock and writes the append-only history row, so a client that bypasses the API still cannot skip a step, edit the clock, assign without `requests.assign`, assign to a non-staff user, or leave no trace. History and comments are append-only.
- **Children are not referenced by identity**: a request carries a count and an age range, free text the family chooses to write (the form warns against names and phone numbers), and answers validated against the type's schema. No child profile, photo or contact detail is attached.
- **Limits:** 20 open requests per person, 200 messages per request. Unknown form answers are refused rather than stored.
- **Known gaps:** no attachments or uploads; no notifications, so a family must open the app to see a question; history integrity relies on the trigger plus append-only grants (an authorised actor on a request can still append a history row of their own, but cannot change a status without the trigger); free-text fields are not scanned for contact details.

### Sourcing and booking (Phase 6, migration 0013)
- **A vendor never learns who asked.** A vendor cannot read `requests`, request comments, history or users (tested: zero rows). What it needs to quote is a **snapshot** stored on the inquiry when operations send it (what, when, how many children, ages, budget, the community's name and area, the form answers). Free text a family writes in the description is shown to the vendors asked; the form warns against names and phone numbers.
- **Offering is the team's decision, visibility follows it.** A family reads a quote only after operations shortlisted it (or after they accepted it); vendors that were not offered are invisible to them, as are other vendors' prices and the team's matching scores. Community administrators see a request but none of the vendor options.
- **Matching cannot be talked past safety.** The set of vendors that can be suggested is exactly the set a family could see in the catalog (active, serving the community, current vetting, approved by the community unless it turned that off), and eligibility is re-checked at the moment inquiries are sent. A manual addition (with a logged reason) is possible only for an eligible vendor.
- **The booking's life is enforced by the database** (`bookings_enforce`): the parties and the agreed price never change; the family can open a booking only for a quote they accepted, at its price; only operations set the schedule and confirm or complete it; a vendor can confirm only a scheduled booking, only as itself; operations cannot confirm before the vendor; cancelling needs a reason and `bookings.cancel` after confirmation; a finished booking is frozen. A family can cancel only while the booking still waits for the vendor.
- **Choosing is one atomic step.** Accepting a quote, moving the request on and opening the booking happen in one transaction; the generic transition endpoint refuses to do it without them.
- **Known gaps:** (1) when a family accepts, the other vendors' open inquiries are released at the *team's* next step (scheduling), because families cannot update inquiries; until then those vendors could still send a quote that nobody will read. The same applies after a family cancels. (2) Quotes carry no attachments; (3) offline payments, reviews and community approval of a booking are not built (Phase 6.3); (4) vendor-visible request text is free text.

### Payments, reviews, notifications and the stage marker (Phase 6.3, migration 0014)
- **Payments are records, not money.** Money moves offline (assumption B). Operations record what happened; the records are append-only and only operations can write them. The family reads what *they* paid; the vendor reads what the family paid *and* its own platform fee; nobody else reads any (tested at the database and the API). The fee is set only by operations with `payments.record`, can never exceed the agreed price, and a finished booking is otherwise frozen.
- **Reviews are moderated before anyone reads them.** Only the requester of a *completed* booking can write one, once; it is private to its author and operations until published; it can be read only by people who could see the vendor; what it says can never be edited (trigger, tested over the admin connection); only moderators publish or decline (a decline needs a reason the author reads, and is final); the vendor can answer a published review once and nothing else. Public pages show a rating and text, **never the author's name** (moderators see it). Moderation exists mainly to catch children's names and contact details.
- **Notifications leak nothing.** An email is a subject, one sentence and a link: no names, prices, request text, questions or reasons (those stay in the app), tested by searching every message sent in a journey for private strings. They go to the people concerned (a vendor's team by *role permission*, not by guess), only to verified, active accounts, and only after the action commits. A failing mail provider cannot break an action. The ops desk address is configuration, not data from a request.
- **The stage marker** (`request_stage_flags`) lets a vendor learn only that a request it was asked about has moved on, nothing about the request; it is written through a trigger by whoever changes the request (the family or operations), readable by vendors only for requests they were asked about.
- **Closed:** the stale-inquiry window of 6.1/6.2 (a vendor quoting on a request that moved on) is gone.
- **Known gaps:** (1) no email *provider* is wired in, so nothing leaves a development machine until one is chosen, and WhatsApp is not built; (2) no per-person opt-out of emails yet; (3) review text is free text (moderation is the control); (4) payment records have no attachments (receipts) and no reversal entry (a mistaken record needs a compensating process, to be designed with the founder); (5) the fee is a typed amount, not a rule.

### Saved offerings (Phase 7, migration 0015)
A resident's saved list is private to that person: the SELECT and DELETE policies require both the community being acted in and the person's own id, there is no platform or vendor clause, and the table has no UPDATE grant. Insert requires the catalog permission, the caller's own id and community, not being in platform scope, and an offering the caller can see at that moment (the existence test runs under the caller's own row-level security, so a draft, or a vendor the community does not show, cannot be saved and the API answers 404 as for an unknown id). A saved row reveals nothing by itself: reading the list joins through `offerings`, so an offering that is later unpublished, or whose vendor is suspended or withdrawn, stops appearing without being exposed. A trigger caps a person at 200 per community. Ratings shown on catalog cards count only published reviews, never a person's own pending one. Mutation-checked (`mutate-p8`: 17 of 18 backend mutations caught; the 18th, saving a draft, is a redundant layer because a resident's row-level security already hides unpublished offerings from the policy's existence check; 6 of 6 web mutations caught; see TEST_PLAN.md).

### Concerns: the reporting channel (migration 0016)
A report goes to the platform team only. The SELECT policy shows a report to its reporter and to platform staff holding `concerns.manage` in platform scope; there is deliberately **no vendor, community or other-family clause**, because the vendor named, or a community administrator, may be the subject and must never learn who reported. Insert requires being the reporter in the organization being acted in, holding `concerns.create`, not being in platform scope, an `open` report with no outcome, and a vendor (if named) that the reporter can see (the existence test runs under the reporter's own row-level security, so a vendor id cannot be probed; the API gives the same 404 for unseen and unknown). Update is platform-only with `concerns.manage`; a trigger makes what a report says immutable, moves status forward only, refuses a decision without the words the reporter will read, and records who decided. A trigger caps ten undecided reports per person. Emails to the desk and to the reporter say only that something was reported or updated (category word aside); the audit record carries the category, never the words. The public `/safety` page shows the team's contact only from validated build settings (a plain address and a plain number; anything else shows nothing, so a typo or hostile value cannot become a `javascript:` or header-injection link). Known gaps: no private notes or attachments on a report, the reporter cannot add to it, nothing escalates an unanswered report beyond showing how long it has waited, and a person with no community or vendor cannot use the in-app form (the public page and its contact details are the way in).

### Vetting stays current (Phase 4 review, migration 0011)
- The catalog **fails closed**: a vendor is shown to families only while every required vetting requirement has a verified document that has not expired. Previously a document that lapsed after activation changed nothing. Expiry needs no scheduled job (the policy compares a stored date with today); the platform team can list lapsed and expiring vendors, and the vendor's own team sees a warning.
- Residents cannot read vendor documents, so the decision is kept in `vendor_vetting_summary` (a flag and a date per vendor), written only by the platform team and kept in step with the documents by a trigger that reacts only to *verified* documents, so vendors can never vouch for themselves.
- **Vendor owners and administrators now require two-step verification** (data in `roles.requires_mfa`; reverse with one statement if the founder decides otherwise).
- **Known minor gap:** a community's members can read the id, travel fee and travel note of vendors that list their community as a place served, including vendors that are not approved or not active yet (the catalog policy needs that table readable; hiding it would need a privileged function).

### Web application (Milestone 2.3)
- Browser talks only to the web origin; `/api` is proxied, so the session cookie is first-party (HttpOnly, SameSite=Lax) and the API's Origin check sees the web origin.
- Headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (camera, microphone, geolocation, payment off), partial CSP (`frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`), `X-Powered-By` removed. **Gap:** no `script-src` yet; adding it requires nonces for Next's inline bootstrap scripts and is planned before production.
- Open redirects blocked: `next=` is accepted only for paths under `/app` (tested with hostile inputs).
- Passwords and codes use proper `autocomplete` values and are never placed in URLs; one-time email links carry tokens in the query string, so the token pages set `robots: noindex` and the token is single-use and short-lived.
- Anti double-submit and focus management are shared (`useSubmit`); the UI hides what a user cannot do, but the API remains the only enforcement point.

### Known gaps (tracked in DEVELOPMENT_PROGRESS.md)
- **No real email provider.** Emails go through a `Mailer` port; only a memory mailer (tests) and a console mailer (development) exist, and production refuses to start with the console mailer. Account verification and password reset therefore cannot work in production until the notifications milestone adds a provider adapter. Sending also happens inline; it should move to the job queue.
- No recovery-code regeneration or admin-initiated MFA reset yet (a user who loses both device and recovery codes needs manual support).
- `MFA_ENCRYPTION_KEY` has no rotation procedure yet (ciphertext carries a `v1` marker to allow it).
- No breached-password check (needs an outbound service).
- Registration reveals whether an email is registered (409). Acceptable for pilot behind rate limits; revisit with email verification.
- Rate-limit counters are in memory (single instance). Move to the database or a shared store before running more than one API instance.
- `view_as` support access is not implemented.

## 5. Authorization model
Permissions are strings in the catalog below. Roles bundle permissions per scope. Assignments bind user, role and scope. Controllers declare required permission and the scope source. Services re-check object-level ownership. The UI mirrors but does not enforce.

### Permission catalog (MVP draft)
| Area | Permissions |
|---|---|
| Platform | `platform.manage`, `audit.read`, `users.manage`, `roles.manage`, `settings.manage`, `view_as.use` |
| Communities | `communities.create`, `communities.read`, `communities.update`, `communities.approve`, `memberships.approve`, `facilities.manage`, `policies.manage` |
| Families | `families.read_own`, `families.manage_own`, `children.manage_own` |
| Vendors | `vendors.create`, `vendors.read`, `vendors.update`, `vendors.vet`, `vendors.approve`, `vendors.suspend`, `vendor_staff.manage`, `offerings.manage`, `availability.manage`, `vendor_documents.manage` |
| Catalog | `categories.manage`, `catalog.read` |
| Requests | `requests.create_own`, `requests.read_own`, `requests.read_community`, `requests.read_all`, `requests.comment_public`, `requests.comment_internal`, `requests.transition` (with per-transition permission), `requests.assign`, `requests.cancel_own` |
| Sourcing | `matching.run`, `matching.override`, `inquiries.send`, `inquiries.respond`, `quotes.create`, `quotes.compare`, `bookings.confirm`, `bookings.complete`, `bookings.cancel` |
| Community approvals | `community.approve_vendor`, `community.approve_request` |
| Payments (offline) | `payments.record`, `payments.read` |
| Reviews | `reviews.create`, `reviews.moderate`, `reviews.reply` |
| Notifications | `notifications.read_own`, `notifications.templates.manage` |
| Media | `media.upload`, `media.read` (scope checked) |

Seed roles from the brief (Super Administrator, Platform Administrator, Business Operations, Vendor Manager, Customer Support, Finance, Marketing, Analytics, Community Administrator/Manager/Staff, Resident, Parent/Guardian, Family Member, Vendor Owner/Administrator/Staff/Service Provider, Business Partner, Sponsor, Event Organizer) are created as data. Only the roles used by the MVP receive real permissions; others are seeded empty and documented as reserved.

## 6. Data protection
TLS everywhere; encryption at rest via managed Postgres and storage; application-level encryption for sensitive fields (identity document references, MFA secrets); secrets in the platform secret store, rotated; backups encrypted; logs scrubbed of PII; retention periods per data type; test and staging use synthetic data only.

## 7. Secure SDLC
Dependency and secret scanning in CI, SAST checks, code review checklist covering authz, validation and output encoding, security tests in CI (authz matrix, tenant leakage, rate limit, upload abuse), threat model reviewed per phase, pre-launch review with the `security-review` pass and an external penetration test if budget allows.

## 8. Incident response (pilot)
Owner: founder. Runbook before go-live: detection channels, severity levels, containment steps (revoke sessions, disable vendor, rotate secrets), notification obligations (assess with counsel), post-incident review.

## Appearance (migration 0018)
- `user_preferences`: own row only (select, insert, update); no platform or "same community" clause. Update grant is per column, so the user id of a row cannot change.
- `community_branding`: readable by anyone acting in that community (a palette name is not personal data); written only with `communities.update` in that community, or platform scope. Every change is audited with the palette name only.
- Only names of contrast-tested palettes are stored (CHECK constraint and strict zod enums); no colour value is ever accepted. See `adr/0005-curated-palettes.md`.
- Step-by-step form drafts (`useDraft`) live in the tab's session storage only, are cleared on success, and must never hold passwords or codes.

## Community security settings (migration 0019)
- `require_two_step_all_members` (default off): when on, `resolveTenantState` treats everyone acting in that community as needing two-step verification, exactly like a role with `requires_mfa`; the person must also still HAVE a confirmed credential, so a session verified before two-step was turned off does not count. Platform scope is unaffected. Other communities the person belongs to are unaffected.
- `invite_code_max_days` (default no limit): a new code's life is the shorter of what was asked and the limit; a code requested without expiry gets the limit. Existing codes keep their dates.
- Changed only with `policies.manage` (community administrators, platform operations), audited as `community.policy_changed` with the value. The web asks for confirmation and states the consequence first.
- Session length (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`) and the password rules are platform-wide configuration, deliberately not per community.

## Community banners (migration 0020)
- Read: members acting in the community see only banners that are on and inside their dates; `communities.update` in that community, or platform scope, sees all. Written only with `communities.update` there, or platform scope. A tenant-isolation fixture covers the table.
- A banner's picture is the name of an approved photo slot (CHECK constraint and zod enum), never an upload or outside address; its link must match `^/app(/segment)*/?$` in both the database and the API, so a banner cannot send residents to another site.
- Audit records carry ids and switches only (picture name, active, changed field names), not the banner's words.
