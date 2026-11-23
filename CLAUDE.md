# Kidos (working name): Community Experience & Commerce Network

Read first: `docs/DEVELOPMENT_PROGRESS.md` (current state, decisions, known gaps) and `MASTER_PROMPT.md` (standing brief and rules).

## Commands (Windows; pnpm runs through corepack)
```
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 run typecheck
corepack pnpm@9.15.0 exec eslint .
corepack pnpm@9.15.0 exec vitest run          # real PostgreSQL 16: embedded unless TEST_DATABASE_ADMIN_URL is set
corepack pnpm@9.15.0 run db:up                # Docker Postgres (optional; Docker Desktop was unreliable on the dev machine)
corepack pnpm@9.15.0 run dev:api              # needs .env copied from .env.example
corepack pnpm@9.15.0 run dev:stack            # embedded Postgres (persistent in .data/pg) + migrations + API on :4000, no Docker needed
corepack pnpm@9.15.0 run dev:web              # Next.js on :3000, proxies /api to :4000 (set API_ORIGIN to change)
corepack pnpm@9.15.0 run check:load            # pilot-scale timings (throwaway DB, about 2 minutes); LOAD_SCALE=0.05 for a quick smoke run
corepack pnpm@9.15.0 run e2e                  # Playwright (installed Chrome): starts its own throwaway DB, API and production web build
```
`dev:stack` also seeds one account per role (`tools/dev-seed.ts`, list in `apps/api/src/dev-accounts.ts`, password `Kidos-dev-login-2026`) and enables a passwordless `/api/v1/dev/*` route that powers the "Development quick sign-in" panel on `/login`. Only `tools/stack.ts` in dev mode opts in (`devQuickLogin`); the route throws unless `NODE_ENV=development`, and never register it anywhere else.
Run e2e against servers already running with `E2E_REUSE=1`. Dev emails (verification and reset links) print in the `dev:stack` console.

## Layout
- `packages/db`: SQL migrations, migration runner, `withContext` (per-request RLS context), test harness (`@kidos/db/testing`).
- `apps/api`: Fastify API. Routes in `src/routes`, guards in `src/guards.ts`, auth primitives in `src/auth`.
- `packages/ui`: design system (tokens and components, tests include WCAG contrast of the tokens). `apps/web`: Next.js app and Playwright e2e in `apps/web/e2e`. `tools/stack.ts`: dev and e2e stack.
- `docs/`: product, architecture, security, API conventions, ADRs. Keep them updated with every milestone.

## Rules that matter every session
1. **Tenant data access only through `withContext`.** The database trusts `app.tenant_id`; the only code allowed to choose a tenant is `resolveTenantState` in `guards.ts`, which verifies an active membership first. Never pass a tenant id from request input straight into `withContext`.
   The only exceptions are the two join flows in `routes/membership.ts` (a person who is not yet a member). They are safe only because migration 0007's row-level policies allow nothing beyond a pending self-membership or a valid-code self-join. Do not copy that pattern.
2. **New tenant-owned table = `tenant_id` column + forced RLS + policies + an entry in `TENANT_TABLES` in `packages/db/test/tenant-isolation.test.ts`.** The suite fails otherwise.
3. **Never edit an applied migration.** Add a new numbered file. The runner rejects checksum changes.
4. The app role gets column-level grants only where updates are needed. Do not widen grants casually.
5. Permissions are data (`permissions`, `roles`, `role_permissions`); code checks permission strings via `requirePermission`, never role names.
6. Secrets, tokens and passwords never go into logs, audit metadata or error messages.
7. A feature is not "Completed" until it meets the Definition of Done in `MASTER_PROMPT.md` section 10. Report incomplete work honestly as Partially Completed.
8. UI: every page must pass the axe scans in `apps/web/e2e` in light and dark; new colors must come from tokens and keep the contrast test green; interactive elements need accessible names (lint enforces `jsx-a11y`); no text without a label, no meaning by color alone.
   Pictures: real photographs come only from the founder, as files named after a slot in `apps/web/public/photos/` (`docs/PHOTOS.md`), each with a permission record in `apps/web/photo-credits.json` (a test enforces it; never put records or documents in `public/`, it is served). Never invent photos of people, and download one only after the founder approves that exact file (source, licence, size), above all for children; the nine Pexels photos now in place have no model release (`LAUNCH_READINESS.md` B12). Drawn stand-ins (`Illustration`, `packages/ui`): colours only from `--k-art-*` tokens, every trig-computed coordinate through `q()`. Pictures are decorative (empty description, `aria-hidden`) and never on safety, concerns, payments or ops screens.
   Always build the context with `dbContext(state)` in route handlers: it carries the verified `permissions`, which the READ policies use (`app_ctx_has_any_permission`). A context without them reads less, never more. New SELECT policies should be least-privilege: your own rows, or a named permission.
   What residents may see of vendors is decided only by row-level security (active + serves the community + approved by it). Do not add tenant or approval filters in catalog queries, and do not widen those policies.
   A vendor is an organization (type `vendor`): `/vendors/:id/...` routes use `makeRequireVendorPermission`, `/communities/:id/...` use `makeRequireCommunityPermission`. Platform-only data (internal notes) lives in its own platform-only table.
   zod: never put `.default()` in a schema that is later made `.partial()` for PATCH (a rename once un-published offerings); merge a patch into the stored record and validate the whole.
   Request workflow (migration 0012): statuses, transitions, permissions, note rules and SLA hours are DATA (`workflow_*`, `sla_rules`) enforced by the `requests_enforce_workflow` trigger. A new status or step = a new migration inserting rows (and tests), never an `UPDATE requests SET status` shortcut. The API sets `app.note` (transaction-local) before changing a status. Internal notes are `request_comments` with `visibility = 'internal'`: never expose them through a query that a family or community administrator can reach.
   RLS policies must not reference each other in a cycle (`organizations` policy ↔ a table whose policy reads `organizations` fails with infinite recursion). Needing another table's rows inside a policy usually means a small summary table readable by the right audience (see `vendor_vetting_summary`).
   Sourcing and booking (migration 0013): vendors never read `requests`; they read an inquiry's **snapshot**, built in `routes/sourcing.ts` from an explicit list of fields. Adding a field to the snapshot means deciding it is safe for every vendor asked, and the test that checks the payload for the requester's id and email must stay. Matching eligibility (`matching.ts`) must equal the catalog's visibility rules; the parity test enforces it. A family's choice goes through `POST /requests/:id/quotes/:quoteId/accept` only. A booking's rules live in the `bookings_enforce` trigger; add rules there, not only in routes.
   `SELECT ... FOR UPDATE` also requires the UPDATE policy to pass, so under a vendor or family context it can turn "not in the right state" into a 404. Prefer a guarded `UPDATE ... WHERE status = ...` and check `rowCount`.
   `INSERT ... ON CONFLICT DO UPDATE` needs UPDATE privilege on the columns even when nothing conflicts: on tables without that grant, check for an existing row first.
   Notifications (`notify.ts`): queue messages in an `Outbox` during the transaction and `flush()` after it commits; never put names, prices, request text, questions or reasons in an email (subject, one sentence, a link); recipients come from role permissions (`vendorTeamEmails`), not from request input. Reviews: only moderators publish; author names never go to public payloads. Payments: records only, append-only, never visible to a party they do not concern (the family never sees the vendor fee).
   A trigger-maintained marker table (`vendor_vetting_summary`, `request_stage_flags`) is the pattern for letting a policy read a decision about data the caller may not read. Keep the trigger the only writer.
   Saved offerings (migration 0015): a person's private list. Own rows only (their id and the community they are acting in), no platform or vendor clause, insert and delete only. The catalog joins `saved_offerings` without a user filter on purpose: row-level security is the filter, so never add a platform or "see all" policy to it. Reading what is saved always goes through `offerings` (so unpublished or withdrawn things vanish); never read a saved row's offering id alone into a response. Catalog ratings count only `status = 'published'` reviews.
   Concerns (migration 0016): the reporting channel. A report is readable only by its reporter and by platform staff with `concerns.manage` in platform scope. Never add a vendor, community-administrator or "same community" clause to any policy on `concerns` (the vendor or administrator may be the subject), never put a report's words, the vendor's name or the reporter in an email subject or body, an audit record or a log line, and never let a request body choose the reporter, status or outcome. A decision always carries the words the reporter will read; findings go in `vendor_internal_notes`.
9. A new list that platform staff read across every community, newest first, needs an index that starts with the sort key (tenant-first indexes do not serve it; see migration 0017). Run `check:load` after adding or changing a list or a policy.
10. After any change touching auth, tenancy or grants, re-run the full suite; for security rules, extend the mutation checks described in `docs/TEST_PLAN.md`.
