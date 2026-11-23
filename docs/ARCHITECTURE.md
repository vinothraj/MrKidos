# Architecture

Status: Proposed (Phase 1). Each decision below becomes an accepted ADR on founder approval.

## 1. Style
**Modular monolith** in a TypeScript monorepo. One deployable API, one web app, one worker process (same codebase as the API). Modules own their tables, expose a service interface and talk to other modules through interfaces or in-process domain events. Boundaries are enforced with lint rules so a module can be extracted later.

```
apps/
  web/            Next.js PWA: public site, resident, vendor, ops, admin shells
  api/            NestJS: HTTP API + worker entry point
packages/
  ui/             design system (tokens, components)
  contracts/      shared DTO/zod schemas, API types
  config/         eslint, tsconfig, shared config
  testing/        fixtures, test helpers
docs/             this documentation
infra/            docker compose, deployment configs
```

## 2. Modules (build order in bold = MVP)
**identity**, **tenancy**, **rbac**, **audit**, **configuration**, **communities**, **membership**, **families**, **vendors**, **catalog**, **requests** (with workflow), **matching**, **quotes-bookings**, **notifications**, **reviews**, **media**; later: events, rentals, finance (ledger arrives lightly in MVP for offline payments), ai, analytics, commerce (reserved).

Dependency rule: lower modules (identity, tenancy, rbac, audit, configuration, media) never import higher ones. Cross-module writes go through the owning module's service.

## 3. Decision index (ADR candidates)

| # | Decision | Choice | Main alternative rejected and why |
|---|---|---|---|
| 0002 | Language and repo | TypeScript, pnpm monorepo | Python backend: splits language and shared types |
| 0003 | Web | Next.js + React, PWA | SPA: poor SEO for public pages |
| 0004 | API | **Fastify 5 + zod (accepted, see `adr/0004-api-framework-fastify.md`)**; originally proposed NestJS | NestJS: decorator metadata needs extra test tooling; explicit guards are clearer for security logic |
| 0005 | Database | PostgreSQL | MySQL: weaker row-level security |
| 0006 | Data access | Drizzle or Kysely, SQL migrations | Prisma: awkward with RLS and per-transaction settings |
| 0007 | Tenancy | Shared schema, `tenant_id` column, RLS with per-transaction setting | Schema-per-tenant: high operational cost |
| 0008 | Jobs | Postgres-backed queue (pg-boss class) | Redis: extra service to run and secure |
| 0009 | Auth | Server-side sessions, Argon2id, TOTP; vetted library | JWT-only sessions: harder revocation |
| 0010 | Storage | S3-compatible object storage, signed URLs, private by default | Local disk: not viable on PaaS |
| 0011 | Hosting | Low-cost PaaS + managed Postgres, one region, staging and prod | Kubernetes: unjustified ops load |
| 0012 | Testing | Vitest, real Postgres via Testcontainers, Playwright, axe | Mock DB: hides RLS and migration bugs |

Choice among Drizzle/Kysely and the specific auth library are decided with a short spike in Phase 2 (timebox 1 day each) against: RLS support, type safety, migration quality, maintenance activity.

## 4. Tenancy design
- `organizations(id, type, parent_id, ...)` where type is `platform`, `community`, `vendor` (extensible).
- Users are global; access is through `memberships` linking user to organization with role assignments scoped to that organization.
- Every tenant-owned table has `tenant_id` (the owning organization). Rows needing two tenants (e.g. a request owned by a community involving a vendor) use an explicit **owner** (`tenant_id`) plus relationship tables granting limited visibility (e.g. `request_vendor_access`).
- Request handling: authenticate, resolve active tenant context, open a transaction, `SET LOCAL app.tenant_id` and `app.user_id`, RLS policies filter on them. Platform staff use an explicit audited `platform_scope` role with a separate policy path.
- Database role used by the app is **not** table owner and **does not bypass RLS**. Migrations run as a separate role.
- Automated test suite enumerates every tenant-owned table and asserts cross-tenant select, insert, update, delete all fail. A new table without a policy fails CI.
- File storage keys are prefixed by tenant; signed URL issuance checks permission.
- Search (when added) filters by tenant at query time; no shared index without tenant filters.

## 5. RBAC design
- Tables: `permissions(code)`, `roles(id, scope_type, key, system_flag)`, `role_permissions`, `role_assignments(user_id, role_id, scope_type, scope_id)`.
- Scopes: platform, community, vendor, user (self). Permission inheritance: a platform-scope role can include community-level permissions for all communities (explicit flag, audited).
- Guards: `@RequirePermission('requests.transition', { scopeFrom: 'request.community' })`. No code compares role names.
- Frontend gets the effective permission set for the active context and hides/disables UI; server remains authoritative.
- Permission catalog and seeded roles: see `SECURITY.md`.

## 6. Workflow engine (requests)
Data: `workflow_definitions`, `workflow_statuses`, `workflow_transitions(from, to, permission, requires_fields, side_effects)`, `sla_rules`. Requests reference a workflow version. Transition is a single service function: check permission, check preconditions, write status, append `status_history`, enqueue notifications, write audit, all in one transaction. Default workflow seeded per ADR 0001.

## 7. Dynamic forms
`request_types` and `form_schemas(version, json_schema, ui_schema)`. Submissions store `answers` JSONB and `schema_version`. Server validates against the schema; UI renders from the same schema with accessible components. Unknown fields are rejected.

## 8. Money and ledger
Amounts are integer minor units plus ISO currency. MVP records quotes, booking totals, platform fee and offline payment status. Ledger entries are append-only with reversal entries; every entry stores a breakdown snapshot and links to request, booking, vendor, community. Commercial rules live in config with a rule version recorded on each calculation. No hardcoded percentages.

## 9. Notifications
Domain event to notification rule to template render to channel adapter (in-app, email now) via the job queue with retry/backoff and a delivery log. Preferences checked before send. WhatsApp/SMS/push adapters implement the same interface later.

## 10. Media
Direct-to-storage uploads using short-lived signed URLs after a server-side permission check; server verifies type by content, size, records metadata, marks `scan_status` (hook for malware scanning), generates thumbnails in a job. Downloads via signed URLs; nothing public by default except explicitly published vendor portfolio images.

## 11. Observability and operations
Structured JSON logs with correlation ID and tenant/user IDs (no PII in message bodies), error tracking service, health/readiness endpoints, queue dashboards, daily backups plus restore drill, environment parity through Docker for local, staging and production on the PaaS. CI: lint, type-check, unit, integration (real Postgres), e2e smoke, dependency and secret scanning.

## 12. Configuration and feature flags
Versioned config files plus a `settings` table for runtime values (brand name, currency, locale, time zone, business hours, SLA defaults, matching weights, feature flags). Flags can be scoped to tenant. Changes to settings are audited.

## 13. Scaling path
Vertical scaling of one Postgres and stateless API instances first; read replicas and queue extraction later; module extraction candidates in order: notifications, media processing, matching, AI. No change to contracts required because modules already talk through interfaces.

## 14. Risks specific to this architecture
| Risk | Mitigation |
|---|---|
| RLS misconfiguration | Test that enumerates tables; app DB role is non-owner; policies reviewed in migrations |
| Over-flexible forms/workflows become a maintenance burden | Seeded defaults, minimal admin UI, schema validation, versioning |
| Single-process failure | Health checks, restart policy, jobs durable in DB |
| Vendor lock-in to a PaaS | Docker-based deployment, standard Postgres and S3 APIs |
