# Phase 0 Findings: Discovery and Assessment

Status: **Draft for founder approval.** No application code has been written.
Date: 2026-11-21

## Answers received (inputs to this plan)

| Question | Answer |
|---|---|
| Team | Solo founder + Claude (one human reviewer) |
| Time to first live pilot | 6 months |
| Hosting | Low-cost PaaS, minimal ops |
| Pilot | Community already known; payments handled offline at pilot |

Not yet answered (non-blocking for Phase 1, blocking before launch): brand name, legal entity and compliance status, vendor pool size, who staffs the Operations desk (see section 3).

---

## 1. Executive summary

- The project is **greenfield**: the folder contains only `MASTER_PROMPT.md`. Nothing to preserve, nothing to migrate. Verified tools on this machine: Node 22.23, npm 10.9, Docker 28.3, Git 2.49, Python 3.10. **PostgreSQL is not installed locally; we will run it in Docker.**
- The brief describes a platform that a funded team would take 18 to 36 months to build. With one founder and a 6-month pilot target, **the only viable strategy is a narrow, concierge-assisted MVP that proves one loop**: a resident requests an experience, operations sources a vendor, a booking is confirmed and completed, and the resident reviews it. Everything else is sequenced behind that loop.
- The biggest risks are **business and operational, not technical**: vendor supply, the manual workload of the Operations desk, child-safety trust, and scope. The architecture below is chosen to keep the technical risk low so effort goes into those.
- Recommended architecture: **TypeScript modular monolith, PostgreSQL with row-level security for tenant isolation, one design system, PWA front end, Postgres-backed job queue.** No microservices, no Redis, no Kubernetes at launch.
- Headline recommendation: treat the first six months as **three deliverables**: (A) secure foundation, (B) request-to-booking loop live in one community with real vendors, (C) rentals-lite and hardening only if the pilot shows demand. Events, financial engine, AI and analytics are post-pilot unless evidence changes this.

## 2. Existing project structure and technology

```
Kidos/
  MASTER_PROMPT.md        (the standing brief)
  docs/PHASE_0_FINDINGS.md (this file)
```

No code, dependencies, database, auth, tests, deployment or technical debt exist. Items 4 to 8 of the Phase 0 checklist (existing functionality, architecture, debt, security issues, incomplete features) are therefore **not applicable**; the security assessment below covers the *planned* design.

## 3. Challenges to the brief

These are places where following the brief literally would hurt you.

1. **Scope versus capacity.** 20+ modules, 14 phases, AI, rentals, events, finance and analytics for a solo founder in 6 months is not achievable at the quality bar stated. The brief's own rule ("do not mark incomplete as complete") means honest status will show most of it unfinished. Cut scope, not quality.
2. **The Operations desk is a business, not a feature.** In a concierge model, someone must triage requests, call vendors and chase quotes daily. Until that person exists (probably you), software cannot fix response times. Build tools that make that person fast (templates, one-click inquiry to several vendors, quote comparison), not a general workflow platform first.
3. **Configurable everything is expensive.** Configurable workflows, roles, forms, rules and themes are each a mini-product. For the MVP, make them *data-driven with a small set of seeded defaults and a basic admin UI*, and defer visual workflow builders. Build the generic engine only for the three things that truly vary: request forms per category, status transitions, and commercial rules.
4. **Vendor supply decides success.** The platform has no value without reliable vendors in the pilot community. Plan to onboard the first 15 to 25 vendors manually (you or ops enter data) and treat self-serve onboarding as secondary.
5. **Cold-start and disintermediation.** Residents and vendors can bypass the platform after first contact. The default "reveal contact details only after confirmed booking" and a visible value-add (vetting, coordination, guarantees) are the mitigation. Decide your commission stance before pilot vendors are signed.
6. **"Kids-first, never kids-limited" and the name.** "Kidos" signals kids-only. If the long-term brand is broader, rename before any public UI exists. Cheap now, expensive later.
7. **AI sequencing.** AI is last in your roadmap, which is correct. The only AI feature likely worth building before pilot is the request assistant (natural language to structured request); it directly reduces ops workload. The rest is speculative until there is data.
8. **Mobile.** A PWA is sufficient for pilot. Push notification support on iOS PWAs exists but is limited; WhatsApp and email are the realistic reach channels in India. WhatsApp Business API needs a provider, business verification and approved templates (weeks of lead time; start early).

## 4. Business assumptions to validate in the pilot

| Assumption | How we will test it |
|---|---|
| Parents will submit requests through an app rather than WhatsApp groups | Measure requests per 100 households in month 1; keep a WhatsApp fallback entry route for ops to log requests manually |
| Community administrators will approve vendors and events quickly | Track approval turnaround; make community approval optional per community |
| Vendors will respond to inquiries within 24 hours | Track vendor response time and rate; use it in matching |
| A commission or coordination fee is acceptable | Run the pilot with explicit fee disclosure; record resident and vendor reactions |
| Quotes are mostly custom, not fixed-price packages | Measure share of requests resolved by fixed packages versus custom quotes; this decides how much catalog self-serve is worth |

## 5. Security, privacy and compliance assessment (planned design)

This is a **children-and-family platform**, which raises the bar above a typical marketplace.

**Top risks and the design response**

| Risk | Response |
|---|---|
| Unvetted vendor interacts with children | Vendor vetting checklist (ID, background-check attestation, references, safety training) with expiry; community can require extra checks; admin approval before any listing is public |
| Child data exposure | Guardian-only accounts; child profile limited to nickname, age band, interests; no child photos or locations; field-level access control; no child data to AI by default |
| Cross-tenant data leak | PostgreSQL row-level security plus tenant-scoped data access; automated leakage tests in CI; no raw cross-tenant queries outside a reviewed "platform scope" |
| Account takeover | Argon2id hashing, rate limiting, lockout/backoff, mandatory MFA for admin and ops roles, session rotation |
| Malicious uploads | Type and size validation, content sniffing, private storage, signed URLs, malware-scan hook; no public bucket listing |
| Prompt injection via vendor or resident text | Treat all user text as untrusted; AI has no write access; human confirmation for every action |
| Disintermediation and payment fraud | Contact reveal policy; offline payments at pilot tracked through ledger entries with receipts |
| Data protection law | India's DPDP Act (guardian consent for children, purpose limitation, correction and deletion, breach process) |

**Legal flags (not legal advice; get counsel before launch):** DPDP Act obligations for children's data, GST treatment of commission and coordination fees, vendor-platform contract terms (liability for incidents at events, insurance requirements), residential community permission rules, and terms for rentals (damage, deposits). Whether data must stay in India depends on counsel's reading; choosing an India or nearby region from the start avoids rework either way.

## 6. Recommended architecture

### 6.1 Principles
Modular monolith; boring, well-supported technology; one language; database as the source of integrity; every module testable in isolation; no dependency without a reason.

### 6.2 Proposed stack (each becomes an ADR in Phase 1; challenge any of these)

| Concern | Recommendation | Why | Alternatives considered |
|---|---|---|---|
| Language | TypeScript everywhere | One language for solo work, shared types and validation | Python/Django (strong admin, but splits language from a React front end) |
| Repo | pnpm monorepo: `apps/web`, `apps/api`, `packages/*` | Shared design system and types; enforced module boundaries via lint | Single Next.js app (simpler, but weaker module boundaries and background-job story) |
| Web | Next.js + React, responsive PWA | Public SEO pages plus app shells in one framework | Vite SPA (no SEO), native apps (deferred) |
| API | NestJS (modular, DI, OpenAPI from decorators) | Natural fit for a modular monolith and testability | Fastify plain (lighter, more hand-rolled structure) |
| Database | PostgreSQL | Integrity, RLS, JSONB for dynamic forms, optional PostGIS for geo matching | MySQL (weaker RLS), document DBs (poor fit for ledgers and relations) |
| Data access | Drizzle (or Kysely) with plain SQL migrations | Works well with RLS and explicit SQL; Prisma is weaker with RLS and per-transaction settings | Prisma |
| Tenancy | RLS policies keyed on a per-transaction `app.tenant` setting, plus tenant-scoped repositories | Defense in depth: bug in app code cannot leak rows | Schema-per-tenant (operational overhead), app-layer filters only (too fragile) |
| Jobs | Postgres-backed queue (e.g. pg-boss) | No extra infrastructure; transactional enqueue; enough for notifications, SLA timers, media jobs | Redis/BullMQ (extra service to run) |
| Auth | Server-side sessions with secure cookies, Argon2id, TOTP MFA for staff; use a vetted library rather than hand-rolling | Simpler and safer than JWT sessions for a first-party app | JWT, third-party identity provider (cost, lock-in) |
| Storage | S3-compatible object storage with signed URLs | Standard, CDN-ready | Local disk (not viable in PaaS) |
| Email | Transactional provider (e.g. SES or Resend) | Deliverability handled | Self-hosted SMTP |
| Hosting | Low-cost PaaS with managed Postgres, one region, staging plus production | Minimal ops for one person | Raw cloud VMs, Kubernetes |
| Testing | Vitest, Testcontainers for real Postgres, Playwright for end to end, axe for accessibility | Real DB in tests catches RLS and migration bugs | Mock databases (hide the bugs that matter here) |
| CI | GitHub Actions: lint, type-check, tests, dependency and secret scan | Standard | Other CI |

### 6.3 Core design decisions to carry into Phase 1

- **Tenant model:** `organizations` (communities, vendors, platform) with a `tenant_type`; users belong to many via memberships; every tenant-owned row carries `tenant_id`. Vendors participate in many communities through explicit relationship rows (`community_vendor_approvals`), not by owning data in them.
- **RBAC:** `permissions` (stable code strings), `roles` (per scope), `role_permissions`, `role_assignments(user, role, scope_type, scope_id)`. Code checks permissions only.
- **Dynamic request forms:** category-level JSON schema stored and versioned; submitted answers stored as JSONB with the schema version for historical fidelity; validated server-side against the schema.
- **Workflow engine:** state machine data (`statuses`, `transitions`, `transition_permissions`, `sla_rules`) with an append-only `status_history`. Seed one default flow; admin edits are versioned.
- **Money:** integer minor units plus currency, append-only ledger entries, reversals instead of edits, a stored breakdown snapshot per transaction. Payment gateway is a later adapter.
- **Matching:** deterministic weighted scoring with explanations; weights in config; manual override logged. AI re-ranking optional later.
- **AI layer:** adapter interface, versioned prompts, per-tenant budgets and flags, redaction, human confirmation; the product works fully with AI switched off.
- **Notifications:** event to template to channel adapter pipeline with retries and delivery log; in-app and email first; WhatsApp behind the same interface when verified.
- **Audit:** append-only audit table written in the same transaction as the change; not editable from the app.

### 6.4 Domain modules (build order)
identity, tenancy and rbac, configuration, audit, communities, membership, vendors, catalog (categories, offerings), requests and workflow, notifications, matching, quotes and bookings; later events, rentals, finance, ai, analytics; commerce reserved.

## 7. Recommended implementation strategy

1. **Thin vertical slices**, each ending in something demonstrable, not horizontal layers.
2. **Walking skeleton first** (Phase 2): sign in, tenant switch, permission-aware navigation, CI green, one RLS isolation test, deployed to staging. Everything later hangs off it.
3. **Build the ops tooling before the resident polish**, because the pilot lives or dies on ops speed. Resident UI must still be good, but a plain, fast request form beats a rich catalog at pilot.
4. **Seed real data early**: the pilot community, 15 to 25 real vendors, real categories. Real data exposes bad assumptions faster than demos.
5. **Security and accessibility in the Definition of Done, not a final phase.**
6. **Decision log and progress file** updated every milestone so any session can resume.

## 8. Recommended MVP scope

**In (pilot MVP):**
- Authentication with MFA for staff; tenant switching
- RBAC with seeded roles and a basic admin UI
- Community onboarding (assisted by ops) and resident membership with admin approval or invite code
- Family profile with guardian-managed child profiles (minimal fields)
- Vendor onboarding (ops-assisted plus self-serve profile editing), vetting checklist and approval
- Category taxonomy with per-category request forms
- Request lifecycle with default workflow, comments, internal notes, attachments, status history, SLA timers
- Operations workspace: queue, request detail, vendor shortlist with explainable match scores, inquiry to multiple vendors, quote capture and comparison, booking confirmation, completion
- Basic offering catalog with browse and search (read-only discovery)
- In-app and email notifications
- Offline payment tracking (record amounts and settlement status; no gateway)
- Reviews after completed bookings
- Audit log, error tracking, backups, CI, staging and production

**Out for MVP (explicit non-goals):** online payments, product commerce, full event module, rentals (see Phase C), AI features other than optional request assistant, advanced analytics, native apps, multiple languages in UI (keep i18n-ready), seasonal themes, visual workflow builder, SMS, WhatsApp (start provider onboarding in parallel).

## 9. Roadmap and estimates

Estimates assume **solo founder + Claude**, where Claude does most implementation and the founder reviews, supplies business input and runs the vendor side. Ranges are calendar weeks, with confidence. The biggest swing factor is review latency, not coding time.

| Phase | Scope | Estimate | Confidence |
|---|---|---|---|
| 0 Discovery | This document, approvals | 1 week | High |
| 1 Product and architecture | Personas, journeys, ERD, RBAC model, API conventions, ADRs, metrics dictionary, UX structure | 2 to 3 weeks | High |
| 2 Foundation | Repo, CI, DB, auth, RBAC, tenancy plus isolation tests, audit, design system, app shell, staging | 4 to 6 weeks | Medium |
| 3 Communities and residents | Onboarding, membership, families | 3 to 4 weeks | Medium |
| 4 Vendors | Onboarding, vetting, offerings, availability, workspace | 4 to 5 weeks | Medium |
| 5 Requests and operations | Dynamic forms, workflow engine, ops workspace | 5 to 7 weeks | Medium-low |
| 6 Matching and booking | Matching, inquiries, quotes, comparison, booking | 4 to 5 weeks | Medium-low |
| **MVP total (2 to 6)** | | **22 to 30 weeks** | **Medium-low** |

**Honest reading:** the upper end of the MVP estimate slightly exceeds the 6-month target. Options to fit the date are listed in section 10 (decision A). Phases 7 to 14 are not estimated yet; they will be sized in Phase 1 after the MVP design stabilizes. Treat any estimate beyond Phase 6 as unreliable today.

## 10. Decisions for you

**A. Hit 6 months or protect scope?** The MVP estimate is 22 to 30 weeks.
Recommended: **cut scope to fit** by deferring self-serve vendor onboarding (ops enters vendors), keeping the offering catalog read-only, and using a fixed default workflow (editable only through seed or config files) until after pilot. This protects the date and the quality bar. Alternative: keep scope and accept a 7-month pilot.

**B. Pilot payments.** Offline payments are assumed. Confirm that vendors are paid by residents directly or by you, because the ledger design differs (pass-through versus platform-collected).

**C. Brand name.** Decide before Phase 2 UI work. Provide alternatives and I will propose a short list.

**D. Who runs the ops desk during the pilot?** If it is you, the ops workspace is the most important UI in the product and gets design priority.

**E. Rentals timing.** Rentals are valuable but introduce inventory, deposits, damage and disputes. Recommended: **after the request-to-booking loop is proven**, not in the MVP.

**F. Legal.** Book a short consultation on DPDP (children), vendor contracts, GST on fees and event liability before the pilot, in parallel with Phases 2 to 4.

## 11. Dependencies and who supplies them

| Dependency | Owner | Needed by |
|---|---|---|
| Pilot community name, admin contact, venue list, rules | Founder | Phase 3 |
| First 15 to 25 vendors and their documents | Founder | Phase 4 |
| Brand name and basic identity | Founder | Phase 2 |
| Domain name, email sending domain (SPF/DKIM) | Founder | Phase 2 |
| Cloud/PaaS account, object storage, error tracking | Founder (Claude configures) | Phase 2 |
| Transactional email provider account | Founder | Phase 5 |
| WhatsApp Business provider and template approval | Founder | Start by Phase 4 (long lead) |
| Legal counsel | Founder | Before pilot |
| Payment gateway account | Founder | Post-pilot |
| AI provider API key and budget | Founder | Only when an AI feature is approved |

## 12. Initial backlog

### Phase 1 (documentation, each is a deliverable with acceptance criteria)
1. Personas and top journeys (resident, vendor, ops, community admin): reviewed by founder against real pilot situation.
2. Functional requirements with MoSCoW priority mapped to MVP boundary.
3. Non-functional requirements with measurable targets (performance, availability, RPO/RTO, accessibility).
4. ERD for tenancy, identity, RBAC, communities, vendors, catalog, requests, workflow, bookings (events, rentals, finance as outlines).
5. RBAC model: permission catalog, seeded roles, scope rules, examples of denied access.
6. API conventions (errors, pagination, filtering, idempotency, versioning).
7. Security architecture and threat model (STRIDE on the request and booking flows, upload flow, AI flow).
8. UX structure: site map, navigation per persona, design tokens draft, key screen wireframes (resident request, ops queue, ops request detail, vendor profile).
9. Metrics dictionary for pilot success.
10. ADRs for each row of section 6.2.

### Phase 2 (foundation stories)
1. Monorepo scaffold, lint, type-check, formatting, commit hooks. *Done when CI is green on a clean clone with one command locally.*
2. Docker Compose with Postgres; migration tooling; seed script. *Done when a new machine runs the app with documented commands.*
3. Auth: register, sign in, sign out, reset password, session management. *Done with tests for lockout and session fixation.*
4. MFA (TOTP) for staff roles.
5. Tenancy: organizations, memberships, tenant context middleware, RLS policies. *Done when a leakage test suite proves user A in tenant 1 cannot read or write tenant 2 rows across every table.*
6. RBAC: permissions, roles, assignments, permission guard, UI permission hook. *Done with a permission matrix test.*
7. Audit framework: append-only log written in-transaction.
8. Error handling, structured logging with correlation IDs, health endpoints.
9. Design system v0: tokens, core components, light and dark, reduced-motion, accessibility checks.
10. App shell: responsive navigation driven by permissions; resident, vendor and ops layouts.
11. Staging deployment with secrets management, backups and a tested restore.
12. Test framework: unit, integration (real Postgres), end to end smoke, axe checks in CI.

## 13. Gate

**Not started:** Phase 1 and everything after. No code exists.
Please review sections 3, 8, 9 and 10 and reply with answers to decisions A to F (short answers are fine). On approval I will begin Phase 1 documentation. I will not scaffold code until Phase 1 is approved.
