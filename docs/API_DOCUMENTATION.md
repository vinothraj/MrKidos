# API Conventions

Status: conventions (Phase 1). Endpoint reference will be generated from code (OpenAPI) from Phase 2 onward and published at `/api/docs` in non-production environments.

## Style
REST over HTTPS, JSON, base path `/api/v1`. Resource nouns, plural. Breaking changes require `/v2`; additive changes do not.

## Authentication and context
Cookie session for the web app. Active tenant is sent as `X-Tenant-Id` header (validated against the user's memberships; never trusted alone). CSRF protection for cookie-authenticated mutating requests (SameSite cookies plus anti-CSRF token). Every request gets `X-Request-Id` (generated if absent) that appears in logs and error bodies.

## Authorization
Each route declares a required permission and scope source. Missing permission: `403`. Resource outside the caller's visibility: `404` (do not reveal existence).

## DTOs and validation
Request and response bodies are explicit DTOs defined in `packages/contracts` with schema validation (e.g. zod). Database models are never returned directly. Unknown properties are rejected. Money fields: `{ "amountMinor": 1000000, "currency": "INR" }`. Timestamps ISO 8601 UTC. IDs are opaque strings.

## Pagination, sorting, filtering
Cursor pagination for lists: `?limit=25&cursor=...` (max limit 100), response `{ "data": [...], "page": { "nextCursor": "...", "hasMore": true } }`. Sorting: `?sort=-createdAt`. Filters: `?filter[status]=submitted&filter[communityId]=...`. Free text: `?q=`. Allowed sort and filter keys are whitelisted per endpoint.

## Errors
Problem-details style:
```json
{
  "error": {
    "code": "validation_failed",
    "message": "One or more fields are invalid.",
    "details": [{ "field": "preferredDate", "message": "Must be in the future." }],
    "requestId": "..."
  }
}
```
Codes are stable strings. Status codes: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict (state or uniqueness), 422 business rule violation, 429 rate limit, 5xx server (no internals leaked).

## Idempotency
Mutating endpoints with side effects (create request, send inquiry, confirm booking, record payment) accept `Idempotency-Key`; replays within 24 h return the original response.

## Rate limits
Per-IP and per-user limits, stricter on auth, upload and search endpoints; responses include `Retry-After` and standard rate limit headers.

## Concurrency
Entities that multiple people edit (requests, quotes, bookings) expose `version` and use `If-Match` or a `version` field; mismatch returns `409`.

## Implemented so far (Milestone 2.2a)
Verified by `apps/api/test/*.test.ts`. Base path `/api/v1` except health.

| Method and path | Purpose | Auth / permission |
|---|---|---|
| `GET /health/live`, `GET /health/ready` | Liveness; readiness (checks the database) | none |
| `POST /auth/register` | Create account, start session (201) | none, rate limited |
| `POST /auth/login` | Start session (200) | none, rate limited; lockout after 5 failures |
| `POST /auth/logout` | Revoke current session (204) | session |
| `GET /me` | User, organizations with roles, active tenant, permissions | session |
| `POST /me/tenants/switch` `{ tenantId \| null }` | Set the session's active tenant (204) | session + active membership |
| `GET /me/sessions`, `DELETE /me/sessions/:id` | List and revoke own sessions | session |
| `GET /admin/audit?limit&cursor` | Tenant audit trail, newest first, keyset pagination | `audit.read` in the active tenant |

### Added in Phase 3 (communities, membership, families)
**Access model.** `/communities/:id/...` routes work for platform staff in platform scope (any community) and for a community's own staff acting in that community (verified membership); any other community id answers `404 not_found`, indistinguishable from a community that does not exist. The specific permission is in brackets.

| Method and path | Purpose | Permission |
|---|---|---|
| `GET /directory/communities?q&limit` | Find ACTIVE communities: id, name, city, locality, type only | any signed-in user |
| `POST /communities` | Register a community (draft) | `communities.create`, platform scope |
| `GET /communities?status&q&limit&cursor` | List communities, no private details | `communities.read`, platform scope |
| `GET /communities/:id` | Full record, including private details and the transitions this caller may take, each with its `blockers` checklist | `communities.read` |
| `PATCH /communities/:id` | Change profile or private details (never status) | `communities.update` |
| `POST /communities/:id/transitions` `{ to, note? }` | Move through draft, verification, active, suspended. 422 `transition_blocked` lists what is missing; the step's own permission is checked (`communities.update` to submit or send back, `communities.approve` to activate or suspend) | `communities.read` + the step's permission |
| `GET /communities/:id/history` | Status history | `communities.read` |
| `GET /communities/:id/admins`, `POST` `{ email }`, `DELETE /:userId` | Community administrators. The last administrator of an active community cannot be removed (422 `last_admin`) | read: `communities.read`; change: `communities.assign_admin`, platform scope |
| `GET/POST /communities/:id/facilities`, `PATCH/DELETE /:facilityId` | Venues (max 100) | read: `communities.read`; change: `facilities.manage` |
| `GET /communities/:id/policies`, `PUT /communities/:id/policies/:key` `{ value }` | Configurable policies; values are validated against `policy_definitions` | read: `communities.read`; change: `policies.manage` |
| `POST /communities/join` `{ code, unitLabel? }` | Join instantly with an invite code. Every failure (unknown, malformed, expired, revoked, used up) gives the same 400 `invalid_code`; rate limited per session | signed in, verified email |
| `POST /communities/:id/join-requests` `{ unitLabel, note? }` | Ask to join an active community (403 `join_requires_invite` if the community is invite-only) | signed in, verified email |
| `GET /me/join-requests`, `DELETE /me/join-requests/:communityId` | See and withdraw pending requests | signed in |
| `GET /communities/:id/members?status&limit&cursor` | Members and pending requests | `memberships.approve` |
| `PATCH /communities/:id/members/:userId` `{ action: approve\|reject\|suspend\|reinstate\|remove }` | Decide on a member. Cannot act on yourself; community administrators can only be managed by platform staff | `memberships.approve` |
| `POST/GET /communities/:id/invite-codes`, `DELETE /:codeId` | Create (code shown once), list (hint only), revoke | `memberships.approve` |
| `GET /interests` | Interest options for child profiles | signed in |
| `GET /me/family`, `POST /me/family/children`, `PATCH/DELETE /me/family/children/:id` | The guardian's own children. First child needs `consentAccepted: true`. Fields: nickname, birthYear, interests only | signed in, verified email |
| `GET /me/family/export`, `DELETE /me/family` | Download everything held (file); erase all children and withdraw consent | signed in, verified email |

`GET /me` now also returns `platformStaff`. Context header `X-Platform-Scope: on` is sent by the web app when platform mode is on.

**New error codes:** `transition_blocked` (422, with `details` as a list of messages), `invalid_transition`, `note_required`, `user_not_found`, `last_admin`, `platform_scope_required`, `limit_reached`, `community_not_active`, `invalid_code`, `already_member`, `request_pending`, `contact_admin`, `join_requires_invite`, `cannot_act_on_self`, `invalid_state`, `consent_required`.

### Added in Phase 4 (vendors, vetting, offerings, catalog)
**Access model.** A vendor is an organization of type `vendor`, so it reuses tenancy and the status workflow. `/vendors/:id/...` routes work for platform staff in platform scope (any vendor) and for a vendor's own team acting in that vendor (verified membership); any other id answers `404 not_found`. Suspended vendors are switched off for their own people exactly like suspended communities (403 `tenant_suspended`).

| Method and path | Purpose | Permission |
|---|---|---|
| `GET /categories`, `POST /categories`, `PATCH /categories/:id` | Two-level category tree (reads: any signed-in user). Changes are platform-scope only, loops refused | read: signed in; change: `categories.manage` |
| `POST /vendors`, `GET /vendors?status&q&limit&cursor` | Register (draft) and list vendors | `vendors.create` / `vendors.read`, platform scope |
| `GET /vendors/:id` | Full record (private details, platform notes only for platform scope), the transitions this caller may take with their `blockers`, and category ids | `vendors.read` |
| `PATCH /vendors/:id` | Profile and private details. `internalNotes` is refused for anyone but the platform team (403 `platform_only_field`) | `vendors.update` |
| `POST /vendors/:id/transitions` `{ to, note? }` | draft, verification, active, suspended. Verification needs description, location, contact, a category and a place served. Activation needs every required vetting document verified and unexpired (422 `transition_blocked`, with the list). Approving and suspending are separate permissions and need a note | `vendors.read` + the step's permission (`vendors.update`, `vendors.approve`, `vendors.suspend`) |
| `GET /vendors/:id/history` | Status history | `vendors.read` |
| `PUT /vendors/:id/categories` `{ categoryIds }` | Replace the vendor's categories (sub-categories only) | `vendors.update` |
| `GET/POST /vendors/:id/service-areas`, `DELETE /:areaId` | Communities (active only) or cities served, with a travel fee. Exactly one of `communityId` or `city` | read: `vendors.read`; change: `vendors.update` |
| `GET/POST /vendors/:id/staff`, `DELETE /:userId` | The vendor's team. Only the platform team can add or remove an owner; the last owner of an active vendor stays (422 `last_owner`); nobody removes themself | read: `vendors.read`; change: `vendor_staff.manage` |
| `GET /vendors/:id/vetting` | Each requirement with the state of the vendor's documents (missing, submitted, verified, expired, rejected) and `readyForApproval` | `vendor_documents.manage` |
| `POST /vendors/:id/documents`, `PATCH/DELETE /:docId` | Submit, edit and withdraw a document record (title, reference, dates). Only while it is still `submitted`; a decision locks it. No file upload yet | `vendor_documents.manage` |
| `POST /vendors/:id/documents/:docId/review` `{ decision: verify\|reject, note? }` | The platform team decides. A rejection needs a note; an expired document cannot be verified; a vendor can never review its own documents | `vendors.vet`, platform scope |
| `GET/POST /vendors/:id/offerings`, `PATCH /:offeringId` | Offerings: pricing model (fixed, hourly, per participant, per event, per day, package, custom quotation), price, duration, group size, ages, terms. Updates are merged with the stored record and the complete result is validated again. Publishing needs a description, duration and cancellation policy (422 `not_ready_to_publish`) | `offerings.manage` |
| `GET /vendors/:id/availability`, `PUT /vendors/:id/availability/weekly-hours` `{ rules }`, `POST /vendors/:id/availability/unavailable`, `DELETE /:blockId` | Weekly working hours (replaced atomically; slots must not overlap) and time off | `availability.manage` |
| `GET /communities/:id/vendors` | Active vendors that serve this community and the community's decision about each (public details only) | `community.approve_vendor` |
| `PUT /communities/:id/vendors/:vendorId` `{ status: approved\|rejected\|revoked, note? }` | Decide about a vendor. Anything but approval needs a note | `community.approve_vendor` |
| `GET /catalog/offerings?q&categoryId&pricingModel&maxPriceMinor&age&minRating&savedOnly&limit&cursor` | (Phase 7: `minRating` 1 to 5 keeps only vendors whose *published* reviews average at least that, so unrated vendors are left out; `savedOnly=true` keeps only the caller's saved offerings; every item carries `rating { count, average }` and `saved`.) Published offerings visible to the resident's community. There is no tenant filter in the query: row-level security decides (vendor active, serves the community, approved by it unless the policy `vendor_approval_required` is off). Not available in platform scope (403 `community_required`) | `catalog.read` |
| `GET /catalog/vendors/:id` | A vendor's public page: profile, categories, published offerings. No private or internal fields. A vendor this community may not see answers 404 | `catalog.read` |
| `PUT /catalog/offerings/:id/saved` | Save an offering for later (Phase 7). Idempotent, 204. An offering the caller cannot see (a draft, a vendor the community does not show) answers 404 exactly as one that does not exist. At most 200 per person per community (422 `too_many_saved`). The list is private to the person | `catalog.read`, not platform scope |
| `DELETE /catalog/offerings/:id/saved` | Remove a saved offering. Idempotent, 204 | `catalog.read`, not platform scope |

### Concerns (migration 0016)
| Route | What it does | Permission |
|---|---|---|
| `POST /concerns` | Report a concern: `category` (`child_safety`, `conduct`, `payment`, `other`), optional `vendorId` (only a vendor the reporter can see; otherwise 404 `vendor_not_found`, the same answer as an unknown id), `subject` (150), `details` (3000). Strict body. At most 10 undecided reports per person (422 `too_many_open`). Emails the desk (`OPS_ALERT_EMAIL`) that something was reported, never what. Not in platform scope | `concerns.create` |
| `GET /concerns/mine` | The reporter's own reports with status and outcome. Never who handled them | `concerns.create` |
| `GET /concerns?view=active\|resolved\|dismissed\|all` | The team's queue, child-safety first then oldest, with who reported and where. Platform scope only | `concerns.manage` |
| `PUT /concerns/:id/status` | `reviewing` (take it on) or `resolved` / `dismissed` with a `resolution` the reporter will read (400 `resolution_required`). Forward only (409 `invalid_state`). Emails the reporter that there is an update, never the outcome. Platform scope only | `concerns.manage` |


**Vetting stays current (Phase 4 review).** `GET /vendors` and `GET /vendors/:id` carry `vetting: { state: current|expiring|lapsed, validUntil }` for active vendors. A vendor whose required documents have lapsed (a document expired, or none is verified) is hidden from residents by the database until renewed; `GET /vendors?vetting=lapsed|expiring` lists them for the platform team. Documents are capped at 100 and offerings at 200 per vendor (422 `limit_reached`).

**Vendor roles.** `vendor_owner`, `vendor_admin`, `vendor_staff`, `vendor_service_provider` (permissions are data, see SECURITY.md). Vendor staff manage availability and respond to enquiries but do not edit the catalog or documents.

**New error codes:** `platform_only_field`, `platform_only_role`, `last_owner`, `already_reviewed`, `document_expired`, `not_ready_to_publish`, `category_exists`, `already_listed`, `community_required`.

### Added in Phase 5 (requests and the operations workflow)
**Who sees what.** A family sees only their own requests; a community's administrators can read (not change) their community's; the platform team in platform scope sees all. A request someone may not see answers `404 not_found`, like one that does not exist. Internal notes, the operations clock (`slaDueAt`, `slaState`) and the owner (`assignedTo`) appear only for the platform team. Staff names appear only to staff and community administrators; a family sees "the team".

| Method and path | Purpose | Permission |
|---|---|---|
| `GET /request-types` | Active request types with their form fields (questions, types, options, limits) | `requests.create_own` |
| `POST /requests` | Make a request in the community you are acting in. Starts `submitted`. Shared fields (title, details, category, offering, preferred date, children, ages, budget, venue) plus `answers` validated against the type's form (unknown keys refused). An offering is accepted only if the catalog would show it to you. At most 20 open requests per person (422 `limit_reached`) | `requests.create_own`, not platform scope |
| `GET /requests?open&status&sla&assigned&mine&q&communityId&limit&cursor` | List: your own, your community's, or (platform scope) all. `sla=overdue\|due_soon` and `assigned=me\|unassigned` are for the platform team. `q` matches the title or the number | `requests.read_own`, `read_community` or `read_all` |
| `GET /requests/summary` | Queue counts: open, overdue, due within 4 hours, unassigned, mine, waiting on a family, by status | `requests.read_all`, platform scope |
| `GET /requests/:id` | Detail with labelled answers, history, the messages this caller may see, the steps this caller may take (`transitions`, each with `noteRequired`) and what they can do (`can`) | as the list |
| `POST /requests/:id/transitions` `{ to, note? }` | Move along the workflow. Which steps exist, who may take them and which need a note are rows of `workflow_transitions`. 409 `invalid_transition` (no such step from here), 403 (not for you), 400 `note_required`. The note is shown to the family | the step's permission |
| `POST /requests/:id/comments` `{ body, visibility?, returnToReview? }` | A message. `visibility` is `resident` (default) or `internal` (team only). A family's reply to a question can set `returnToReview` to send the request back to the queue in the same step. Finished requests take no messages (409 `request_closed`); at most 200 per request | `requests.comment_public` / `requests.comment_internal` |
| `PUT /requests/:id/assignee` `{ userId\|null }` | Assign to a member of the operations team, or unassign (400 `invalid_assignee`) | `requests.assign`, platform scope |

**Workflow (data, not code).** Statuses, transitions and targets live in `workflow_statuses`, `workflow_transitions` and `sla_rules` (migration 0012), enforced by a database trigger as well as the API. Phase 5 defines: submitted, under review, information required (and back to review), approved, with rejection, cancellation by the family, and close-without-booking by operations. Targets: 24 h to start review and 48 h in review (the operations clock), 120 h for a family to reply (not counted against the team). Later phases add sourcing and booking steps as data.

**New error codes:** `invalid_transition`, `note_required`, `request_closed`, `invalid_assignee`, `not_a_member`.

### Added in Phase 6 (sourcing and booking)
**The loop.** An approved request moves: *finding options* (matching, then inquiries) → *asking vendors* → *quotes received* (compare, shortlist) → *shortlisted* (the family chooses) → *booking pending* (date, vendor confirms, operations confirm) → *confirmed* → *completed*. Each status change is a workflow step (data, migration 0013) with its permission; preconditions that need other tables are checked by the API (409 `not_ready`).

| Method and path | Purpose | Permission |
|---|---|---|
| `GET /requests/:id/sourcing` | Operations' working view: matches with score and reasons, inquiries, quotes with lines, the live booking and cancelled ones | `requests.read_all`, platform scope |
| `POST /requests/:id/matching/run` | Suggest vendors. **Eligibility** (safety): active, serves the community, current vetting, approved by the community unless it turned that off: identical to what a family sees in the catalog (tested for parity). **Score** (preference, 0 to 100): category, ages, group size, budget, availability, experience, each with a reason. Replaces earlier automatic suggestions, keeps manual ones. Only while sourcing, asking or comparing (409 `not_in_sourcing`) | `matching.run` |
| `POST /requests/:id/matching/manual` `{ vendorId, reason }` | Add an *eligible* vendor with a logged reason (400 `vendor_not_eligible` otherwise; safety rules cannot be overridden) | `matching.override` |
| `POST /requests/:id/inquiries` `{ vendorIds, message? }` | Ask up to 5 suggested vendors at a time, 8 in total. Re-checks eligibility at send time. The vendor receives a **snapshot** (what, when, how many children, ages, budget, community name and area, the form answers) and never who asked. Moves the request to *asking vendors* | `inquiries.send` |
| `POST /inquiries/:id/withdraw` | Withdraw an inquiry still waiting for an answer | `inquiries.send` |
| `GET /inquiries?status`, `GET /inquiries/:id` | The vendor's inbox and one inquiry with its quotes and booking. Vendor context only; a vendor sees only inquiries sent to it | `inquiries.respond` |
| `POST /inquiries/:id/decline` `{ reason }` | A vendor declines, with a reason | `inquiries.respond` |
| `POST /inquiries/:id/quote` `{ lines[{ kind?, description, quantity?, unitMinor }], validUntil?, notes? }` | A vendor quotes (or operations capture a quote obtained by phone). The **total is computed from the lines** (no client total). One live quote per inquiry (409 `quote_exists`) | `quotes.create` |
| `POST /quotes/:id/withdraw` | Withdraw a received quote to correct it; refused once offered to the family (409 `quote_in_use`) | `quotes.create` |
| `PUT /quotes/:id/shortlist` `{ shortlisted }` | Choose which quotes to offer; only while comparing | `quotes.compare`, platform scope |
| `POST /requests/:id/quotes/:quoteId/accept` | **The family chooses** an offered quote: it is accepted, the request moves to *booking pending* and a booking opens at the quoted price. Only the requester (403 for the team); a bare status change to booking pending is refused (409 `use_accept`) | `quotes.accept` |
| `GET /bookings?status` | A vendor's own bookings, or all (platform scope) | `bookings.confirm` or `inquiries.respond` |
| `POST /bookings/:id/schedule` `{ start, end, venueText? }` | Set or change the date and place. A change clears the vendor's confirmation | `bookings.confirm`, platform scope |
| `POST /bookings/:id/vendor-confirm`, `/vendor-decline` `{ reason }` | The vendor confirms the scheduled date (409 `not_scheduled` before it has one) or declines the booking with a reason | `inquiries.respond` |

Request transitions now also keep related records in step: *confirmed* confirms the booking (409 `vendor_not_confirmed` until the vendor has), *completed* completes it, cancelling or closing cancels it with the note as the reason, and starting again from *booking pending* rejects the chosen quote. The family's request page (`GET /requests/:id`) carries `options` (the quotes offered to them) and `booking`.

**New error codes:** `not_in_sourcing`, `vendor_not_eligible`, `vendor_not_suggested`, `already_asked`, `already_suggested`, `not_open`, `quote_exists`, `quote_in_use`, `not_comparing`, `not_ready`, `not_offered`, `use_accept`, `not_scheduled`, `vendor_not_confirmed`, `vendor_context_required`.

### Added in Phase 6.3 (payments, reviews, notifications)

| Method and path | Purpose | Permission |
|---|---|---|
| `PUT /bookings/:id/fee` `{ feeMinor\|null }` | Set the platform fee the vendor owes for a booking (confirmed or completed; not above the agreed price, not below what the vendor has paid of it). An unchanged value succeeds without touching the booking | `payments.record`, platform scope |
| `POST /bookings/:id/payments` `{ kind, amountMinor, method, paidOn, reference?, note? }` | Record money that moved **offline**: `family_to_vendor` or `vendor_to_platform` (needs the fee set); `method` cash, upi, bank_transfer, card_offline, other. Not for pending or cancelled bookings (409 `booking_not_active`), not dated in the future, never beyond the agreed price or the fee (409 `overpaid`). Append-only; returns the booking with its payment summary | `payments.record`, platform scope |
| `POST /bookings/:id/review` `{ rating 1-5, body? }` | The family reviews a **completed** booking, once (409 `not_completed`, `already_reviewed`). It starts `pending` and is private to its author and operations | `reviews.create`, requester only |
| `GET /reviews?status` | Operations: the moderation queue (author and community shown to moderators only). A vendor: its own published reviews | `reviews.moderate` / `reviews.reply` |
| `PUT /reviews/:id/moderation` `{ decision: publish\|reject, note? }` | Publish, or decline with a reason the author reads (400 `note_required`). A rejected review is final (409 `invalid_state`). Publishing emails the vendor's team | `reviews.moderate`, platform scope |
| `POST /reviews/:id/reply` `{ reply }` | The vendor answers a published review, once (409 `cannot_reply`) | `reviews.reply`, vendor context |
| `GET /me/attention` | What is waiting for the caller in the organization they act in: a family (a reply or a choice needed, a booking to review), a vendor (requests to quote, dates to confirm, reviews to answer), operations (overdue or unowned requests, bookings ready to confirm or unpaid, reviews to check, vendors with lapsed documents). Derived from live state under row-level security | signed in |

**Where payment and review data appears.** Bookings now carry `payments`, `paidMinor`, `balanceMinor`, `paymentStatus` (`unpaid`, `partial`, `paid`); operations and the vendor also get `platformFeeMinor` and `feePaidMinor`, **never the family**. `GET /requests/:id` returns the family's `review`; `GET /inquiries/:id` returns the review of the vendor's booking once published; `GET /catalog/vendors/:id` returns `rating { count, average }` and the published `reviews` (anonymous, with the vendor's reply).

**Notifications (email).** Sent through the `Mailer` port, after the action commits, and never able to break it (a failure is logged). Content is minimal: a subject, one sentence and a link; never names, prices, request text or children's details. Recipients: the vendor's team (a request to quote, a date to confirm, a confirmed booking, a published review), the family (a question, approval, options ready, a proposed date, confirmation, a request to review, a team message) and the operations desk address `OPS_ALERT_EMAIL` for things only a family or vendor can trigger (a new request, a family's reply or choice, a quote, a vendor's decline or confirmation, a new review). Only verified, active accounts are emailed. No provider adapter exists yet: production needs one (ConsoleMailer and FileMailer are refused there).

**Stale inquiries.** `request_stage_flags` marks a request `closed` once options are offered or it is decided or finished. A vendor's inquiry then reads as `withdrawn` ("no longer needed") and a quote is refused (409 `not_open`; the database refuses it too).

**New error codes:** `booking_not_active`, `overpaid`, `fee_not_set`, `fee_below_paid`, `not_completed`, `already_reviewed`, `not_your_booking`, `cannot_reply`.

### Added in Milestone 2.2b
| Method and path | Purpose | Auth |
|---|---|---|
| `POST /auth/email/verify` `{ token }` | Verify email with the emailed single-use link token (204) | none, rate limited |
| `POST /auth/email/resend` | Send a fresh verification link (204, silent if already verified) | session |
| `POST /auth/password/forgot` `{ email }` | Start a reset. Always 202 `{ ok: true }` whether or not the account exists | none, rate limited |
| `POST /auth/password/reset` `{ token, password }` | Set a new password (204); ends all sessions; clears lockout | none, rate limited |
| `POST /auth/password/change` `{ currentPassword, newPassword }` | Change password (204); ends other sessions | session |
| `POST /auth/mfa/enroll/start` | Create an unconfirmed TOTP secret; returns `{ secret, otpauthUri }` | session |
| `POST /auth/mfa/enroll/confirm` `{ code }` | Activate MFA; returns `{ recoveryCodes }` once; ends other sessions | session |
| `POST /auth/mfa/verify` `{ code }` or `{ recoveryCode }` | Complete login for an MFA-pending session | pending session |
| `POST /auth/mfa/disable` `{ password, code }` | Turn MFA off (refused with `mfa_required_by_role` for staff roles) | session |

**MFA login flow.** `POST /auth/login` returns `{ ok: true, mfaRequired: boolean }`. When `mfaRequired` is true the cookie identifies a *pending* session: every route except `/auth/mfa/verify` and `/auth/logout` answers 401 `mfa_required` until the second factor is verified.

**Guarded routes** (those declaring a permission) additionally answer 403 `email_verification_required` for unverified emails and 403 `mfa_enrollment_required` when a role the user holds in that tenant has `requires_mfa` set and the session has not completed MFA. `GET /me` exposes `user.emailVerified`, `mfaEnabled` and `mfaEnrollmentRequired` so a client can route users to the right screen.

**New error codes:** `invalid_token`, `invalid_code`, `incorrect_password`, `mfa_required`, `mfa_enrollment_required`, `mfa_already_enabled`, `mfa_not_enabled`, `mfa_enrollment_not_started`, `mfa_required_by_role`, `email_verification_required`.

**Context headers.** `X-Tenant-Id: <uuid>` selects the tenant for one request (overrides the session's active tenant). `X-Platform-Scope: on` requests platform-wide scope; allowed only for users in `platform_staff` who also belong to the platform organization. Either is rejected with 403 `tenant_forbidden` / `forbidden` if the user lacks the membership.

**Cookie and CSRF.** Session cookie `kidos_sid` (HttpOnly, SameSite=Lax, Secure in production). State-changing requests must send an `Origin` in `ALLOWED_ORIGINS`; a request with a session cookie and no `Origin` is rejected (`origin_required`).

**Error codes seen so far:** `validation_failed`, `invalid_credentials`, `too_many_attempts` (429), `rate_limited` (429), `email_taken` (409), `unauthenticated` (401), `forbidden` (403), `tenant_forbidden` (403), `tenant_required` (400), `invalid_header`, `invalid_cursor`, `origin_required`, `origin_not_allowed`, `not_found`, `internal_error`.

### Appearance (migration 0018)
| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | `/me` | signed in | now also returns `appearance: { themeMode, palette, communityPalette }`; `communityPalette` only for the community the person is acting in |
| PUT | `/me/appearance` | signed in | body `{ themeMode: "system"\|"light"\|"dark", palette: "classic"\|"ocean"\|"forest"\|null }` (strict); own row only |
| GET | `/communities/:id/branding` | `communities.read` in that community, or platform scope | `{ palette, isDefault, updatedAt, updatedBy }` |
| PUT | `/communities/:id/branding` | `communities.update` in that community, or platform scope | body `{ palette }` (strict); audited as `community.branding_changed`; other communities answer 404 |

### Community security settings (migration 0019)
`GET /communities/:id/policies` now returns `category` ("general" or "security"), `updatedAt` and `updatedBy` per policy. Two security policies exist: `require_two_step_all_members` (boolean) and `invite_code_max_days` (enum "none", "7", "30", "90"), set with the existing `PUT /communities/:id/policies/:key` (`policies.manage`). When two-step is required and missing, tenant routes answer 403 `mfa_enrollment_required` and `/me` reports `mfaEnrollmentRequired: true`. `POST /communities/:id/invite-codes` caps `expiresInDays` at the limit.

### Community banners (migration 0020)
| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | `/me/banners` | signed in | up to 5 banners showing now in the community the person acts in; empty in platform scope, vendors, or while two-step setup is owed |
| GET | `/communities/:id/banners` | `communities.update` | every banner, newest first |
| POST | `/communities/:id/banners` | `communities.update` | `{ title, message?, picture?, linkPath?, linkLabel?, startsOn?, endsOn?, active? }` (strict); max 20 per community (409) |
| PATCH | `/communities/:id/banners/:bannerId` | `communities.update` | any of the fields; merged into the stored banner and validated whole |
| DELETE | `/communities/:id/banners/:bannerId` | `communities.update` | 204; audited |

### Security page additions (2026-11-23)
| Method | Path | Guard | Notes |
|---|---|---|---|
| POST | `/me/sessions/revoke-others` | signed in | ends every other session of this person; returns `{ signedOut }`; audited |
| GET | `/me/sign-ins` | signed in | up to 20 own sign-ins in the last 30 days: `{ signedInAt, lastSeenAt, device, state }` (`this_device`, `active`, `signed_out`, `expired`) |

### Audit log filters (2026-11-23)
`GET /admin/audit` (`audit.read`) also takes `area` (`security`, `community`, `members`, `vendors`, `requests`, `concerns`; by the first word of the action) and `days` (1, 7, 30 or 90). Anything else answers 400. Filters only narrow what row-level security already returns.

## Resource map (MVP draft)
| Resource | Examples |
|---|---|
| auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/mfa/verify`, `/auth/password/reset` |
| me | `GET /me`, `GET /me/permissions`, `PATCH /me/preferences`, `GET /me/sessions` |
| tenants | `GET /me/tenants`, `POST /me/tenants/switch` |
| communities | `GET/POST /communities`, `GET/PATCH /communities/:id`, `/communities/:id/facilities`, `/policies`, `/members` |
| families | `GET/POST /families/me`, `/families/me/children` |
| vendors | `GET/POST /vendors`, `/vendors/:id/vetting`, `/documents`, `/offerings`, `/availability`, `/staff` |
| catalog | `GET /categories`, `GET /offerings?filter[...]` |
| requests | `GET/POST /requests`, `GET /requests/:id`, `POST /requests/:id/transitions`, `/comments`, `/attachments`, `/matches`, `/inquiries` |
| quotes and bookings | `POST /inquiries/:id/quotes`, `GET /requests/:id/quotes/compare`, `POST /requests/:id/bookings`, `POST /bookings/:id/complete` |
| reviews | `POST /bookings/:id/review`, `POST /reviews/:id/moderate` |
| notifications | `GET /notifications`, `POST /notifications/:id/read` |
| media | `POST /media/upload-intents`, `POST /media/:id/complete`, `GET /media/:id/url` |
| admin | `/admin/users`, `/admin/roles`, `/admin/settings`, `/admin/audit` |

## Documentation
OpenAPI generated from DTO decorators or schemas, published per environment, validated in CI (breaking-change diff check).
