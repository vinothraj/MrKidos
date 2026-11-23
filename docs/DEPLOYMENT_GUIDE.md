# Deployment Guide

Status: **procedures written and partly verified locally. Nothing has been deployed.** Staging and production need accounts, a domain and an email provider that only the founder can create. Items marked **[VERIFIED locally]** were run on the development machine; items marked **[NOT VERIFIED]** are instructions that have not been executed.

## 1. Artifacts

| Artifact | Build | Notes |
|---|---|---|
| API | `corepack pnpm@9.15.0 run build:api` writes `apps/api/dist/server.mjs` (runtime) and `apps/api/dist/migrate.mjs` (migrations), plus `apps/api/migrations/*.sql` | **[VERIFIED locally]** The built server and migrate command were run against a real PostgreSQL 16: migrations found, server started, register and `/me` worked, no secrets in logs. npm dependencies are external: install with `pnpm --filter @kidos/api --prod deploy <dir>` **[NOT VERIFIED]**. |
| Web | `corepack pnpm@9.15.0 run build:web`, run with `next start` | **[VERIFIED locally]** (the e2e suite runs the production build). Needs `API_ORIGIN` at build time (the rewrite is compiled in). |
| Docker image | Not written | Docker Desktop never started on the dev machine, so an unverifiable Dockerfile was not committed. Most PaaS hosts can build from the commands above without one. |

## 2. Environments

| Variable | Used by | Production requirement |
|---|---|---|
| `NODE_ENV=production` | API | Enables Secure cookies and the https checks below |
| `DATABASE_APP_URL` | API | Connection as the restricted application role (never the owner or a superuser) |
| `DATABASE_ADMIN_URL` | migrate | Owner role that creates tables; used only by the migration step |
| `MFA_ENCRYPTION_KEY` | API | 32 random bytes, base64 (`openssl rand -base64 32`). **Losing it makes every enrolled authenticator unrecoverable**: back it up in the secret manager, separately from database backups |
| `APP_BASE_URL` | API | Public https URL of the web app (startup fails if it is not https) |
| `ALLOWED_ORIGINS` | API | Comma-separated https origins of the web app (startup fails if any is not https) |
| `TRUST_PROXY=true` | API | Required behind the host's load balancer, otherwise rate limits key on the proxy address |
| `SESSION_ABSOLUTE_HOURS`, `SESSION_IDLE_MINUTES`, `AUTH_RATE_LIMIT_PER_MINUTE`, `GLOBAL_RATE_LIMIT_PER_MINUTE`, `EMAIL_COOLDOWN_SECONDS` | API | Defaults are sensible; tighten for staff |
| `OPS_ALERT_EMAIL` | API | Optional. Where the operations desk is alerted to what only a family or vendor can trigger (a new request, a quote, a review). Leave empty to turn these alerts off; other emails go to the people concerned. A shared mailbox is better than one person's |
| `API_ORIGIN` | web build | Internal URL of the API for the `/api` rewrite |
| `NEXT_PUBLIC_BRAND_NAME` | web | Product name |
| `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_SUPPORT_PHONE` | web build | **Set both before launch.** The team's contact details, shown on the public `/safety` page (linked from every footer) for anyone who cannot sign in or has no community yet. Only a plain address and a plain number are accepted; anything else shows nothing. Compiled in at build time, so changing them needs a rebuild |
| `NEXT_PUBLIC_ARTWORK_FALLBACK` | web build | Optional. `none` shows nothing where a photo has not been supplied; the default shows drawn stand-ins. Photos are files in `apps/web/public/photos/` (see `docs/PHOTOS.md`); which exist is read at build or start, so adding one needs a rebuild. **Before launch, every photo needs its permission record** in `apps/web/photo-credits.json` |

**Hard blocker:** the API refuses to start in production because only a development console mailer exists. A real email provider adapter (the `Mailer` port in `apps/api/src/mailer.ts`) must be built and configured before anyone can verify an email or reset a password in production.

## 3. First deployment checklist **[NOT VERIFIED]**
1. Provision managed PostgreSQL 16 in one region (India or nearby), with automated daily backups and point-in-time recovery enabled.
2. Create two roles: the owner (migrations) and `kidos_app` (NOLOGIN group) plus a login member used by the API. The migrations create the `kidos_app` group role if missing; the login role and its password come from the provider or an infrastructure script. The application role must have `NOSUPERUSER NOBYPASSRLS`.
3. Run migrations with the owner: `node apps/api/dist/migrate.mjs migrate` with `DATABASE_ADMIN_URL`.
4. Create the first platform administrator by SQL (insert a user via the registration flow, then insert into `platform_staff`, a membership in the platform organization `00000000-0000-4000-8000-000000000001`, and a `super_admin` role assignment). They must enroll MFA at first sign-in; the role requires it.
5. Start the API and web; check `/health/ready`.
6. Put both behind HTTPS on one domain (web at `/`, API reachable only through the web proxy or on a sibling subdomain listed in `ALLOWED_ORIGINS`).
7. Run the smoke checks in section 5.

## 4. Backup and restore
- **Production:** rely on the provider's automated backups and point-in-time recovery. **Targets (from NFRs): RPO 24 hours or better, RTO 4 hours.** Before go-live, perform a real restore into a separate instance on the chosen provider, run the verification queries below against it, and record the time. **[NOT VERIFIED: provider not chosen]**
- **Local drill [VERIFIED locally]:** `corepack pnpm@9.15.0 run drill:backup` creates a database, adds data, stops the cluster, copies the data directory (cold physical backup), destroys the original, restores from the copy and proves: identical data (digest), row counts, migration history, tenant isolation for the application role, audit log still append-only. Measured restore time on a small dataset: about 7 seconds. This proves our data and security model survive a restore; it does not replace the provider drill.
- **After any restore verify:** `SELECT count(*) FROM schema_migrations` (5 or more); the migration command reports nothing pending; sign-in works; a user of one community cannot see another's rows; `UPDATE audit_log ...` is refused for the application role.
- **Key material:** back up `MFA_ENCRYPTION_KEY` separately. Database backups alone are not enough to restore MFA.
- **Retention:** define the retention period per data type with legal advice (children's data, DPDP) before launch.

## 5. Smoke checks after each deploy
1. `GET /health/live` and `/health/ready` return 200.
2. Register a test account, confirm the email link works, sign in, enroll MFA, sign out and in again.
3. Response headers include `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`; no `X-Powered-By`.
4. Cookies: `kidos_sid` is `HttpOnly; Secure; SameSite=Lax`.
5. `GET /api/v1/admin/audit` is 401 without a session and 403 without the permission.
6. The migration command reports all 17 migrations applied and nothing pending. `GET /safety` (no sign-in) shows the emergency numbers and, once configured, the team's email and phone.
7. The whole loop once, with a test community, a test vendor and two test accounts (the pilot rehearsal in `LAUNCH_READINESS.md` section 4): a request, review, approval, matching, an inquiry, a quote, shortlisting, the family's choice, scheduling, both confirmations, completion, a recorded payment and a review. Check the emails arrive and contain no names, prices or request text.

## 6. Rollback
Application: redeploy the previous build. Database: migrations are forward-only and additive (expand then contract); to undo one, ship a new migration. Never edit an applied migration (the runner rejects checksum changes). For data loss, use the restore procedure above.

## 7a. Performance **[VERIFIED locally, not on the host]**
`corepack pnpm@9.15.0 run check:load` (throwaway database, about 30 times a pilot; see TEST_PLAN.md) times 25 screens and exits non-zero if any is over budget. Run it again after changes to lists or policies. Two operations screens (the summary and the "waiting for me" counts) read every request and grow with the number of requests (about 0.3 s at 30,000); before about 100,000 requests, replace them with trigger-maintained counts. Rate-limit counters are in memory (see below).

## 7. Monitoring and operations **[NOT BUILT]**
Planned before pilot: structured logs shipped to the host's log service (already JSON with request ids and cookie redaction), error tracking, uptime checks on `/health/ready`, alerts on 5xx rate, auth failures and locked accounts, queue depth once background jobs exist, database storage and connection alerts. Rate-limit counters are in memory and need a shared store before running more than one API instance.

## 8. What the founder must provide
Cloud or PaaS account, managed PostgreSQL, domain and DNS, email provider and sending domain (SPF, DKIM), secret manager, error tracking account, and a decision on region. See PHASE_0_FINDINGS.md section 11.
