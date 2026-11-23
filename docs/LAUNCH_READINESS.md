# Launch Readiness

This is the roadmap's "pilot go-live checklist" (after Phase 6). It is not Phase 7 (Discovery catalog) and not Phase 14 (production hardening at scale).

Status as of 2026-11-22. The product loop is built and verified locally (request, review, match, inquire, quote, compare, choose, schedule, confirm, complete, pay offline, review). **Nothing has been deployed and no real person has used it.** This document is the honest list of what stands between here and a first pilot community, in priority order, so work is done in the right order and nothing is forgotten.

Priority tiers: **A** = blocks any real user; **B** = blocks the pilot going well; **C** = can wait until the pilot has taught us something.

## 1. What is NOT a blocker (already done and verified locally)
- The whole loop, with tenant isolation enforced by the database, vendors never seeing who asked, moderated reviews, append-only history and payment records.
- 577 automated tests, 118 passing browser tests plus 1 skipped by design (desktop and phone) with accessibility scans in light and dark, mutation checks of the security rules, a backup and restore drill.
- CI workflow written (runs on a git host once the repository is pushed; see A1).

## 2. Tier A: blocks any real user (needs the founder)
| # | Item | Why it blocks | What I need | Lead time |
|---|---|---|---|---|
| A1 | **A git host** (GitHub or similar) and the repository pushed | CI has never run; nothing is under version control (there is no git repository yet) | An account; a decision on private vs public | Minutes |
| A2 | **Hosting and managed PostgreSQL 16** (one region near India) | Nowhere to run it; the backup targets (RPO 24 h, RTO 4 h) need provider backups and point-in-time recovery | An account and a budget ceiling (see the cost note below) | A day |
| A3 | **An email provider and a sending domain** (SPF, DKIM) | **The API refuses to start in production without one**, and nobody can verify an email or reset a password without it. Deferred for now at the founder's request, which is fine while everything runs on a development machine; it becomes the first thing to do the day A2 is done | Choose Resend or Amazon SES (both are simple; Resend is quicker to set up, SES cheaper at volume); I then write a ~50-line adapter for the `Mailer` port and test it | 1 to 3 days for domain verification |
| A4 | **Legal review** of: whether the platform has duties to report a child-safety concern to the authorities (for example under the POCSO Act) and what it may tell the vendor and the reporter, the guardian consent text and retention (DPDP), vendor terms and what a quote or booking binds each party to, the vetting requirements (what a "background check" must mean in India), the rules about what families may write about children, email consent | The product handles children's data and introduces strangers to families. The wording in the product is engineering's draft, not legal advice | A consultation booked now (assumption F in ADR 0001: in parallel with the build) | 1 to 3 weeks |
| A5 | **Secrets and keys** in the host's secret manager, including `MFA_ENCRYPTION_KEY` backed up *separately* from database backups | Losing the key makes every enrolled authenticator unrecoverable | A secret manager (the host's is fine) | Minutes |

## 3. Tier B: blocks the pilot going well (decisions and setup)
Each decision has the **default currently in the code** and my recommendation. Change them by telling me; nothing here needs a rewrite.

| # | Decision | Default now | Recommendation |
|---|---|---|---|
| B1 | **SLA targets** (how long a request may sit) | 24 h to start review, 48 h in review, 72 h finding vendors, 96 h asking, 24 h comparing, 48 h booking, 120 h for a family to reply or choose; all running around the clock | You are the ops desk. Set what you can actually keep: if you cannot look at requests at weekends, say so and I add business hours; a missed target you cannot keep teaches nothing |
| B2 | **Matching weights** (category 40, ages 15, group size 10, budget 15, availability 10, experience 5) | As listed | Leave until you have 20 or more real requests, then adjust from what you override by hand (every manual addition is logged with its reason) |
| B3 | **Required vetting documents** | Identity proof, background check and a child-safety briefing are required; business registration, insurance, first aid and references are optional | Decide with the legal advice in A4 what a "background check" means in India (police verification certificate? a company's own screening?) and whether first aid should be required for anyone alone with children |
| B4 | **Community approval of vendors** | Required by default (a community must approve each vendor before its families see it) | Keep it on for the pilot: it is the safe default for a children's platform |
| B5 | **Community approval of each booking** | Not wired (the policy `event_approval_required` exists but bookings ignore it) | Skip for the pilot unless your pilot community insists; it adds a step for the administrator |
| B6 | **Vendor-owner two-step verification** | Required (since the Phase 4 review) | Keep |
| B7 | **Pilot community and vendors** | None | Name the community and its administrator; get the first 15 to 25 vendors signed (see section 4). This is the biggest risk in the whole plan, not the software |
| B8 | **Operations alert mailbox** (`OPS_ALERT_EMAIL`) and **who watches the concerns queue** | Empty (alerts off); no named person | **Required before launch, not optional.** A shared mailbox that more than one person reads, so a new request or a reported concern does not wait for one person to open the app. Name the person on duty and the target (suggestion: a child-safety report the same day, anything else within two working days) |
| B9 | **Monitoring** | Structured logs only | Uptime check on `/health/ready`, an error tracker, and alerts on 5xx rate and failed sign-ins (the host's built-ins plus a free error tracker are enough for a pilot) |
| B11 | **The team's public contact** (`NEXT_PUBLIC_SUPPORT_EMAIL` and `NEXT_PUBLIC_SUPPORT_PHONE`) | Empty (the `/safety` page shows no contact) | A mailbox and a phone number that a person answers, for anyone who cannot use the in-app form. Required before launch |
| B12 | **Real photographs, with permission** | Nine free Pexels photos (picked and approved on 2026-11-22), with no model release | You asked for real pictures of people, families and children, and approved nine free Pexels photos. They are fine for development and a closed pilot demo, but Pexels gives no model release, so the people pictured (including children) have not agreed to this use: before a wide public launch replace them (up to nine, see `docs/PHOTOS.md`) from a stock licence that includes a model release, or your own with written permission from everyone pictured (a guardian for a child). Record each in `apps/web/photo-credits.json`. Photos of real children from vendors or from families on the platform must never be used without written permission |
| B10 | **The name** | "Kidos" (a working name read from one setting) | Decide before any printed material; the name appears in emails and the header only |

## 4. Rehearsal and pilot plan (do these in order once A1 to A3 are done)
1. **Deploy to staging** following `DEPLOYMENT_GUIDE.md`, run the smoke checks, and do a **provider restore drill** (restore a backup into a second instance, run the verification queries, write down the time).
2. **Full-loop rehearsal with real people playing the roles** (you as operations, a friend as a family, a friend as a vendor, a third as the community administrator): one request through to a reviewed booking. Look for: any email that arrives with something private in it; any screen where someone does not know what to do next; anything that takes more than a minute to find. Write down every surprise.
3. **Seed the pilot**: register the community, assign its administrator, onboard 15 to 25 vendors through the real vetting flow (this will take weeks of back and forth; start early), and approve them in the community.
4. **Soft launch** to one community's administrators first, then a handful of families, then everyone in that community. Watch the queue daily.
5. **Weekly review** of the numbers in `METRICS.md` and of every manual override and every complaint.

## 5. Go / no-go criteria for the first real family
All of these must be true:
- A1 to A5 done; the staging rehearsal (4.2) completed with no privacy surprises and no open defects of high severity.
- The provider restore drill done and the restore time written down (target 4 hours).
- Legal advice received and the product text updated to match.
- At least 10 vendors fully vetted and approved in the pilot community, across at least 4 categories.
- You can answer "who looks at a new request, and how fast" with a named person and a number.
- A test report has been sent from a family account and answered by the named person on duty within the target time, and the contact on the public `/safety` page (email and phone) works. The process is in section 5.1 below.

### 5.1 Complaint and safety response (what exists, and what is still a decision)
**What the product does today (migration 0016, verified):** anyone signed in to a community or a vendor can use **Report a concern** (also linked from every vendor page), under a prominent line to call 112 or 1098 (Childline) first. The report goes to the platform team only, never to the vendor, the community or other families. The team sees a **Concerns** queue with child-safety reports first, counted under "Waiting for you", and is emailed through `OPS_ALERT_EMAIL` (the email says only that something was reported). The team takes a report on, then decides it with words the reporter reads, and the reporter is emailed that there is an update. Suspending a vendor **requires a written note** (so it takes a minute, not one click); it then hides the vendor and its offerings from families at once and switches off the vendor's own people.

**What the product does NOT do (so the process must):**
- There is no chat and no Reply-To on any email, and a person who is not signed in, or has no community or business yet, cannot use the in-app form. The public **Safety** page (`/safety`, linked from every footer, no sign-in needed) gives the emergency numbers and shows the team's email and phone **once you set `NEXT_PUBLIC_SUPPORT_EMAIL` and `NEXT_PUBLIC_SUPPORT_PHONE`** (rebuild the web app). Until you do, it shows no contact, because the product will not invent one.
- Nothing escalates an unanswered report: the queue shows how long each has waited ("Waiting 3 days") and calls out a child-safety report that has waited a day or more, and the desk is emailed once. Name who is on duty and agree what happens at weekends.
- Findings and the reasons for a decision belong in the vendor's internal notes (platform-only); a report has no private notes of its own, no attachments, and the reporter cannot add to it after sending.
- The wording shown to families (the emergency numbers, who sees the report) is engineering's draft for legal review (A4).

**Suggested process (adapt with legal advice):**
1. The person on duty opens the queue at least once a day and reads child-safety reports first.
2. If a child's safety may be at risk, **suspend the vendor first** (a note is required), then investigate.
3. Tell the reporter and, where relevant, the community administrator what was decided, in plain words and without blame, within a day.
4. Record what was found in the vendor's internal notes. Reinstate only with a written reason, or remove the vendor.

## 6. Tier C: later (do not let these delay the pilot)
- WhatsApp notifications (email is enough to start; WhatsApp needs a provider application with a lead time of weeks, so *start the application early* even though the build can wait).
- Per-person email preferences and a digest; live updating of "Waiting for you".
- Attachments (documents, quote PDFs, payment receipts), a document store with scanning, and vendor photos.
- Reversing a mistaken payment record (a compensating-entry process), and fees as rules or percentages.
- Calendar views for operations and vendors; messaging with vendors beyond the inquiry; matching on city-wide service areas.
- Firefox, Safari and real screen-reader testing (do at least a screen-reader pass before a public launch beyond the pilot).
- A shared store for rate-limit counters (needed only when running more than one API instance).
- Rentals, events, products, analytics beyond the queue counts, AI features, native apps (post-pilot by design, ADR 0001).

## 7. Cost note (so the budget conversation is early, not late)
For a pilot, expect small monthly costs: a low-cost PaaS for the API and web, a managed PostgreSQL with backups, a domain, an email provider (free tiers cover pilot volume), and a free-tier error tracker. The large costs are not infrastructure: legal advice, and your time on vendor onboarding and the ops desk.

## 8. What I can do next without waiting for anything
1. Write the email provider adapter as soon as the provider is chosen (A3).
2. Add business-hours SLAs if B1 needs them.
3. Add a read-only "pilot dashboard" for the ops desk (counts by stage, median time to first response, vendor response rates) from data that already exists.
4. ~~Write the operating guide~~ **Done (2026-11-22): `docs/OPERATIONS_GUIDE.md`**, written from the real screens and rules and checked against the code. It has not been used by a person yet: the rehearsal (section 4) should correct it.
5. ~~A lightweight load check~~ **Done (2026-11-22)**: `corepack pnpm@9.15.0 run check:load` seeds about 30 times a pilot and times 25 screens. It found two real problems (the audit trail and the operations queue read every row; fixed by migration 0017). Everything is now well inside the budget. Re-run it after any change to a list or a policy, and once on the staging database before the pilot. It is a check for accidental slowness, not a capacity test.
Tell me which of 2 to 4 you want before the external items are done.
