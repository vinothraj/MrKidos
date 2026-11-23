# MASTER PROJECT PROMPT (v2): Community Experience & Commerce Network

## 0. How to read this prompt

You are acting as CTO, solution architect, product manager, UX lead, full-stack lead, AI architect, QA lead, security engineer and DevOps engineer for one product. You work with me (the founder) in **gated phases**. This document is the standing brief. Re-read it at the start of every session, together with `docs/DEVELOPMENT_PROGRESS.md`.

Priority order when requirements conflict: **1) Security, privacy and child safety, 2) Correctness, 3) Maintainability, 4) Delivery speed, 5) Visual polish.**

**Working-mode rules**

- Stop at every phase gate and at every decision marked **[DECISION]**. Present options, give one recommendation with reasoning, and wait for my answer. Do not decide these silently.
- Make small, reversible decisions yourself and record them as ADRs (`docs/adr/NNNN-title.md`: context, decision, alternatives, consequences).
- Never claim something works unless you ran it. Report test output honestly, including failures and skipped items.
- If something needs external setup (payment gateway, SMS/WhatsApp provider, AI API key, domain, cloud account), build the integration seam and a local fake or sandbox for development, and label it **"Not operational: needs external setup"** in the progress file.
- Keep the app runnable at the end of every milestone. No big-bang commits.

---

## 1. Product vision

Build a **Community Experience & Commerce Network**: a multi-tenant platform where residential communities and families discover, request, book, rent and (later) buy experiences, services and products from trusted local vendors, with an operations team coordinating, and AI assisting.

**Actors:** residents, parents/guardians, children (as profiles managed by guardians, never as independent accounts), community administrators and staff, vendors and their staff, event organizers, sponsors and business partners, platform operations, finance, support, marketing and analytics staff.

**Go-to-market wedge: Kids & Family Experiences** in gated communities and apartment townships, starting with a small number of communities in one city. The architecture, data model and brand must not be limited to children, apartments or any single category. Categories are data, not code.

**Positioning line (editable):** "Discover More. Experience More. Together."

**[DECISION] Brand name.** The working folder name is "Kidos". It implies kids-only, which contradicts the long-term vision. Propose 3 to 5 alternatives or confirm the name before any public UI is built. Use a single configurable `brand` setting so renaming is a config change.

---

## 2. Business context and assumptions to validate

Assumptions (challenge them in Phase 0 and list any I should confirm):

- **Home market: India first** (INR, GST, India time zone, English plus at least one regional language readiness, WhatsApp as a primary channel, UPI as the future payment rail). Currency, locale, tax, time zone and language must still be configuration, not constants.
- Initial operating model is **concierge-assisted marketplace**: residents submit requests, the operations team sources vendors, gets quotes and confirms bookings. Self-serve instant booking and automation come later. Design for the manual flow first, then automate it.
- Payments are **out of scope for the MVP**; the financial model must be payment-ready (see section 8).
- Team size, budget and hosting preferences are unknown. **[DECISION]** Ask for them in Phase 0 and size the stack accordingly (cost-conscious hosting, e.g. a single region with managed Postgres).

**Revenue models to support through configuration (never hardcode percentages):** booking commission, coordination fee, vendor subscription or participation fee, premium and sponsored listings, lead fees, rental commission, exhibition and event sponsorship fees, community revenue share, advertising, and future payment-processing revenue. Rules can vary by category, community, vendor, event and relationship.

---

## 3. Domain model boundaries

Keep these as **distinct domain concepts with separate business logic**, sharing only common infrastructure (media, pricing rules, notifications, audit):

| Concept | Meaning |
|---|---|
| **Experience / Service** | A bookable activity delivered by a vendor (magic show, STEM workshop, coaching) |
| **Request** | A resident's need, which flows through the operations workflow (can become a booking or event) |
| **Event** | A dated occurrence at a community venue, possibly with many vendors, schedules and registrations |
| **Rental** | Time-bound use of physical inventory with availability, deposits, return and inspection |
| **Product** | Sellable goods (future phase, with stock, cart, orders, delivery and returns) |

**Seed taxonomy (data, editable by admins, not code):** Entertainment, Education and discovery (STEM, robotics, coding, astronomy, art, chess, music, dance, cooking, nature), Sports and activities, Experiences (VR, planetarium, exhibitions, carnivals, festivals), Products (toys, kits, books, games), Rentals (telescopes, microscopes, VR, robotics kits, sports gear, cameras, projectors, speakers, bicycles, scooters, trampolines, event equipment). Categories support nesting, per-community enablement and per-category request form schemas.

**Safety exclusions:** live animals are never ordinary rental inventory. Animal-related experiences, if ever introduced, are supervised experiences with welfare, legal, safety and provider-licensing requirements. Also treat rides, inflatables, water activities, fire, and any activity with children and food as **safety-sensitive categories** with mandatory policy checks, documents and vendor attestations, configurable in the safety policy engine.

---

## 4. Non-negotiable platform requirements

### 4.1 Multi-tenancy and isolation
- Tenant hierarchy: platform, then organization/community (and city/region grouping), with vendors as their own organizations that participate in many communities. Tenant types must be extensible.
- Enforce isolation at **API, service, database, file storage, search and analytics** layers. **[DECISION]** Recommend an approach (default suggestion: PostgreSQL row-level security plus tenant-scoped repositories, with automated cross-tenant leakage tests that must pass in CI).
- A user may belong to several tenants with different roles.

### 4.2 RBAC
- Roles, permissions, permission groups and scopes (platform, community, vendor, user) are all **database-driven and configurable**, with system roles seeded from the list in section 5, not hardcoded checks on role names. Code checks permissions only.
- Enforce in API middleware and mirror in UI (hide or disable, but the API is the source of truth). Include permission inheritance where sensible, an audit trail for every grant or change, and a "view as" capability for support that is itself audited.

### 4.3 Configurability (Super Admin Configuration Center)
Configurable without deploys: categories, request types and dynamic request forms, workflows, statuses and transitions (with per-transition permissions and SLAs), roles and permissions, commercial rules, community policies, safety and rental policies, notification templates and channels, languages, currency, time zones, AI models/prompts/limits, feature flags, themes and seasonal branding. Config changes are versioned, audited and reversible.

### 4.4 Security, privacy and child safety (first-class)
- OWASP ASVS/Top 10 as the baseline: strong password hashing, secure sessions/tokens, MFA readiness (required for admin roles), CSRF/XSS/SQLi protection, validation on every boundary, rate limiting, secure uploads (type/size checks, content sniffing, malware-scan hook, private storage, signed URLs), secrets management, encryption in transit and at rest, backups with a tested restore, retention policy, audit logs that cannot be edited through the app.
- **Children's data:** minors never hold accounts. Only guardians create child profiles, with data minimization (first name or nickname, age band or year of birth, interests; no photos, school or precise location by default). Align with India's **DPDP Act** (verifiable guardian consent, purpose limitation, deletion and correction rights, breach process) and keep the design compatible with GDPR/COPPA-style regimes for expansion. **[DECISION]** Confirm legal review is planned before launch.
- Vendors who interact with children need configurable **vetting requirements** (ID verification, background-check attestation, references, safety training), with expiry tracking.
- Resident-to-vendor contact details are shared only at confirmed-booking stage, by default (configurable), to protect residents and platform revenue.
- Moderation and reporting for reviews, messages and uploads.

### 4.5 Accessibility, UX, performance
- WCAG 2.2 AA target: semantic HTML, keyboard navigation, focus management, accessible forms and modals, contrast, alt text, reduced-motion support, zoom and reflow.
- Resident experience is **mobile-first and consumer-grade** (not ERP-like): discovery, search, category browsing, experience cards, recommendations, requests, bookings, rentals, notifications. Vendor and Operations workspaces are professional and desktop-optimized but responsive.
- Budget: Core Web Vitals "good" on mid-range Android over 4G for resident pages; define and track performance budgets.
- Motion is purposeful, subtle and performant, never blocking usability.
- Build a real **design system** (tokens for color, type, spacing, radius, elevation, motion; components including buttons, forms, cards, tables, modal, drawer, toast, dropdown, navigation, breadcrumbs, tabs, filters, pagination, status badges, timeline, calendar, empty/loading/error/success states) with light and dark themes and seasonal theming through tokens. Tone: warm, trustworthy, family-friendly, premium.

### 4.6 Observability and operations
Structured logging with correlation IDs, error tracking, metrics, health checks, background-job visibility with retries and dead-letter handling, feature flags, environment parity (local, staging, production), reproducible local setup with one command, CI running lint, type-check, tests and security scans on every change.

---

## 5. Functional scope by module

Keep a modular monolith with clear module boundaries (each module owns its tables, exposes a service interface, and communicates with others via interfaces or domain events) so any module can be extracted later.

**Identity and access.** Registration, login, contact verification, password reset, session management, MFA readiness, roles and permissions per section 4.2. Seed roles: Platform (Super Admin, Platform Admin, Business Operations, Vendor Manager, Customer Support, Finance, Marketing, Analytics); Community (Administrator, Manager, Staff); Resident (Resident, Parent/Guardian, Family Member); Vendor (Owner, Administrator, Staff, Service Provider); Partner (Business Partner, Sponsor, Event Organizer).

**Communities.** Registration to verification to admin assignment to configuration to approval to activation. Profile (type, location with GPS, units, contacts), facilities and venues with availability, rules and policies, vendor and event approval policies, entry requirements, community-specific categories, fees and revenue share, branding, and notification settings. Resident membership with verification (e.g. admin approval, invite code or unit confirmation, configurable per community).

**Residents and families.** Family profile, guardians, children (minimal data), interests, favorites, privacy settings, history, support contact, reviews (only after a completed booking or rental).

**Vendors.** Individual or business; onboarding wizard (contact verification, profile, categories, service areas and travel radius and fees, offerings, pricing, availability, portfolio, documents) then admin review and activation. Admin actions: approve, reject, suspend, reactivate, request information, verify documents, flag. Vendor workspace: profile, offerings, availability, inquiries, quotes, bookings, calendar, reviews, analytics, staff.
**Offerings** support multiple packages per vendor and these pricing models: fixed, hourly, per participant, per event, per day, package, custom quotation; plus duration, participant limits, age group, equipment and venue requirements, travel and additional charges, terms and cancellation policy.

**Requests (core of the product).** Dynamic request forms driven by category schema; draft to closed lifecycle with **configurable statuses and transitions** (default set: Draft, Submitted, Under Review, Information Required, Approved, Sourcing, Vendor Inquiry, Quotes Received, Shortlisted, Community Approval, Booking Pending, Confirmed, Scheduled, In Progress, Completed, Cancelled, Rejected, Closed). Includes transition permissions, status history, resident-visible updates versus internal notes, attachments, notifications, SLA timers, escalation rules and audit trail.
Reference example to use as a test fixture: community "Aqualily", Magic Show, Saturday 5 PM, 60 minutes, about 100 children and families, budget ₹10,000, Clubhouse, interactive performance.

**Operations workspace (business control center).** Dashboard of action-needed items; request workspace with filters, saved views, bulk actions, board and table views, calendar, timeline, notes and history; vendor sourcing; inquiry to quote to comparison to negotiation to shortlist to community approval to confirmation; event coordination; completion, feedback and settlement.

**Vendor matching.** Rules-based and explainable first: category, locality and service coverage, distance and travel, availability, budget fit, rating, reliability, response time, experience, cancellation history, verification and trust. Weights are configurable. Output: ranked vendors, score, human-readable reasons, availability, price comparison, distance. Operations can override. AI re-ranking is an optional layer added later and must never replace the deterministic baseline.

**Events.** Multi-vendor events (e.g. a community carnival with magic show, games, food stalls, book and toy stalls, STEM workshop, photography, decoration, sponsors) with venue, schedule, capacity, age rules, registrations and participants, budget, sponsorship, checklist, safety requirements, communications, vendor coordination and post-event feedback.

**Rentals.** Listing, inventory with quantities, availability calendar, conflict detection, rental periods (hourly, half day, full day, multi-day, weekend, weekly, custom), deposits, delivery or pickup, active, return, inspection, damage, late fees, disputes, cancellation, review; refund and settlement readiness.

**Discovery (resident-facing).** Search and filters (category, age group, date, location, community, price, availability, rating, duration, indoor/outdoor, interests), personalized recommendations (age, interests, location, community, availability, history, popularity). Start with transparent rules and popularity, add ML or AI later.

**Commercial and financial engine.** Configurable rules engine for commission, fees, taxes (GST-ready), discounts, community share, sponsorship, deposits, late and damage charges, cancellation fees, refunds, payouts and settlements. Use a **double-entry or immutable-ledger style design** (append-only entries, reversal instead of edit), a stored breakdown snapshot for every transaction, and links to request, booking, event, vendor and community. Money stored as integer minor units plus currency. Payment gateway integration is a later seam (design for idempotency, webhooks and reconciliation).

**Notifications.** In-app, email, push; SMS and WhatsApp as provider-pluggable channels (ready, not operational until credentials and approved templates exist). Templates, preferences, event-driven triggers, retry with backoff, delivery status, logs, quiet hours, notification center.

**Analytics.** Role-specific dashboards (platform, community, vendor, operations, finance) with the metrics in the original brief (requests, conversion, response time, SLA, GMV, revenue, repeat customers, retention, vendor response rate, and so on). Define a metrics dictionary first so each number has one definition.

**Products / commerce.** Future phase. Only keep the schema seams and module boundary now; do not build cart or checkout until approved.

**Media.** Images, video, documents with validation, size limits, private storage, signed URLs, thumbnails, CDN readiness, upload progress and error handling, tenant-scoped storage paths.

**API.** Versioned REST (or an approved alternative), consistent conventions, DTO validation, pagination, filtering, sorting, errors, rate limits, OpenAPI documentation generated from code, idempotency keys on mutating endpoints that matter.

---

## 6. AI platform

AI must earn its place with measurable value. Build a **provider-independent AI layer** (adapter interface, model and prompt configuration stored as versioned config, feature flags per capability and per tenant, per-tenant budgets and rate limits, token and cost tracking, logging with PII redaction, evaluation sets, guardrails, prompt-injection defenses, human approval).

**Hard rules:** AI may draft, suggest, summarize and structure. It may not approve vendors, confirm bookings, move money, change permissions or send external messages without an authorized human confirming the exact action. All user-supplied and vendor-supplied text is treated as untrusted data. Children's data is never sent to AI providers unless explicitly allowed by policy and minimized.

**Capabilities, in priority order of expected value:**
1. Request assistant: converts natural language ("a science event for 50 children next Sunday") into structured request fields and asks for missing details.
2. Operations copilot: request analysis, quote comparison, risk flags, alternative vendors.
3. Vendor assistant: descriptions, packages, profile completeness, pricing suggestions.
4. Resident assistant: discovery and recommendations with grounding in the real catalog (no invented offerings).
5. Event planner: concept, schedule, budget, checklist, safety, promotional copy.
6. Business-intelligence insights over the metrics dictionary.

For each capability define: success metric, an offline evaluation set, fallback behavior when AI is unavailable (the product must fully work without AI), and cost ceiling. **[DECISION]** Choose the default provider and model(s) in Phase 11 (the Claude API is the default candidate; confirm current model IDs and pricing at that time).

---

## 7. Technical direction

The directory is currently **empty (greenfield)**, so there is no legacy stack to preserve. In Phase 0 recommend the stack from my constraints rather than defaulting to a fashionable one.

**Starting recommendation to validate or challenge (ADR required):** TypeScript end to end; a modular monolith; PostgreSQL (relational integrity, RLS, JSONB for dynamic forms, PostGIS if geo matching needs it); a typed ORM or query builder with migrations; a job queue for notifications, SLA timers and media processing; object storage with signed URLs; a React-based web app delivered as a responsive PWA (resident app, vendor workspace, operations workspace, public site) from one design system; OpenAPI-documented API; Docker-based local environment; CI on every push; a monorepo with module boundaries enforced by lint rules.
**[DECISION]** Native mobile apps are deferred; a PWA is the plan unless I say otherwise.

Prefer boring, well-supported technology. Every added dependency needs a reason. Avoid microservices, Kubernetes, event buses and GraphQL unless a concrete need is shown.

---

## 8. Phases and gates

Each phase ends with: working software, passing tests, updated docs, a short demo script I can follow, and a **gate** where I approve before the next phase starts. Within a phase, work in small vertical slices (UI, API, database, tests together), never layer by layer for the whole platform.

| Phase | Goal | Gate output |
|---|---|---|
| **0 Discovery** (no code) | Confirm greenfield, validate assumptions, choose stack, risks, MVP cut | Findings report (section 9) |
| **1 Product and architecture** | Personas, journeys, requirements, NFRs, architecture, ERD, RBAC model, API conventions, security and AI architecture, UX architecture, metrics dictionary | Docs approved |
| **2 Foundation** | Repo, environments, CI, DB and migrations, auth, RBAC, tenancy with isolation tests, audit, logging, error handling, design system, app shell, test framework | A user can sign in, switch tenant, and see permission-driven navigation; isolation tests green |
| **3 Communities and residents** | Community onboarding and config, membership and verification, family profiles, facilities, policies | |
| **4 Vendors** | Onboarding, verification, profile, categories, areas, offerings, pricing, availability, portfolio, vendor workspace, admin review | |
| **5 Requests and operations** | Dynamic forms, lifecycle engine, comments, attachments, notifications, resident tracking, operations workspace | **First end-to-end MVP slice** |
| **6 Matching and booking** | Matching, inquiries, quotes, comparison, shortlist, community approval, booking, cancellation | |
| **7 Discovery catalog** | Experience catalog, age and interest filters, recommendations, community events listing | |
| **8 Events** | Multi-vendor events, schedules, registrations, checklists, comms, analytics | |
| **9 Rentals** | Catalog, inventory, availability, booking, deposits, return, inspection, damage, late fees | |
| **10 Financials** | Rules engine, commissions, ledger, payouts, community share, settlements, reports | |
| **11 AI** | Provider abstraction and the capabilities in section 6 | |
| **12 Analytics** | Role dashboards and business intelligence | |
| **13 Commerce** | Only after approval | |
| **14 Production readiness** | Performance, load, security and accessibility testing, backup and restore drill, monitoring, deployment, runbooks | |

**Recommended MVP (to confirm in Phase 0):** Phases 2 to 6 plus a minimal slice of 7, covering one community, resident request to operations sourcing to vendor quote to confirmed booking to completion and review, with in-app and email notifications and manual (offline) payment tracking. Rentals, full events, financial engine, AI and analytics follow in that order of business value unless Phase 0 evidence says otherwise. Challenge this order if you disagree.

---

## 9. Your first action: Phase 0 (no application code)

1. Inspect the working directory and confirm it is empty. If anything exists, assess it before proposing anything.
2. Ask me up to 8 high-leverage questions at once (budget, team, hosting, launch date, first community, legal entity and compliance status, brand, payment timeline). Offer defaults so I can answer quickly.
3. Then deliver one findings document containing:
   1. Executive summary
   2. Assumptions and open questions, with the ones that most change the plan marked
   3. Challenges to this brief (scope contradictions, over-engineering risks, missing requirements)
   4. Recommended stack and architecture, with ADR summaries and rejected alternatives
   5. Tenancy and RBAC approach
   6. Child-safety, privacy and compliance risks (India-first), and vendor-trust risks
   7. Business and technical risks with mitigations
   8. Phased roadmap with effort ranges in person-weeks and stated confidence
   9. Recommended MVP scope and explicit non-goals
   10. Initial backlog for Phases 1 and 2 as small, testable stories with acceptance criteria
   11. External dependencies and who must supply them
4. Stop and wait for my approval before Phase 1.

---

## 10. Engineering standards

**Rules**
- No fake data standing in for backend behavior. Seed and demo data is allowed only through seed scripts that exercise the real backend, clearly separated from production.
- No dead buttons, placeholder endpoints, hardcoded categories, permissions or tenant-specific behavior, no silent error swallowing.
- Do not rewrite working code without a stated reason. Preserve backward compatibility of APIs and migrations (migrations are forward-only and reviewed; destructive changes use expand-then-contract).
- Validate at every boundary; authorize on every request; log security-relevant events.

**Definition of Done** (a feature is **Completed** only if all apply; otherwise label it Not Started, In Progress, Blocked, Testing or Partially Completed):
- UI, API, persistence, validation and permission checks all work together
- Loading, empty, error and success states exist
- Responsive and accessibility checks done (automated checks plus keyboard pass)
- Tenant-isolation and authorization tests exist for any new data access
- Unit tests for business logic; integration tests for APIs and workflows; end-to-end tests for critical journeys
- Existing tests still pass (regression)
- Docs and changelog updated
- Verified by actually running it, with evidence (test output or a short note of what was exercised)

**Critical journeys to cover end to end:** Resident (register, join community, discover, request, track, book, complete, review); Vendor (register, verify, create offering, set availability, respond to inquiry, quote, deliver); Operations (review request, match, inquire, compare quotes, shortlist, book, complete); Rental (discover, check availability, book, receive, return, inspect, complete).

**Milestone protocol:** state objective, affected modules, dependencies and acceptance criteria; implement; test; self-review (including a security and accessibility pass); fix; update docs and progress; report what is done, what is not, what was not verified.

---

## 11. Documentation and progress tracking

Keep these in `docs/` and update them as part of each milestone, not afterward. Keep each short and current rather than long and stale.

- `MASTER_ROADMAP.md`: phases, scope, status
- `DEVELOPMENT_PROGRESS.md`: per phase and feature: status, percent, done, remaining, blockers, risks, tests, estimate versus actual. **Single source of truth for resuming work across sessions.**
- `PRODUCT_REQUIREMENTS.md`, `ARCHITECTURE.md` (with `adr/`), `DATABASE_DESIGN.md` (ERD, tenancy, indexes), `API_DOCUMENTATION.md` (generated OpenAPI plus conventions), `SECURITY.md` (threat model, controls, privacy and child-safety), `UX_DESIGN.md` (design system, journeys, accessibility), `AI_ARCHITECTURE.md`, `TEST_PLAN.md`, `DEPLOYMENT_GUIDE.md` (including backup and restore), `CHANGELOG.md`
- A root `CLAUDE.md` with run, test and lint commands, conventions, module map and the rules in this prompt that matter every session.

---

## 12. Quality bar

The result should feel like a product from a serious modern technology company: distinctive, warm and trustworthy UI; fast on mid-range phones; reliable workflows; clear explanations for every automated recommendation; and code another engineer can maintain. Optimize for the right product and sound foundations, not for volume of code. When something in this brief is ambiguous, contradictory or risky, say so and propose a resolution instead of guessing.
