# ADR 0004: API framework is Fastify, not NestJS

Status: Accepted (Milestone 2.2). Supersedes the "NestJS" proposal in ARCHITECTURE.md section 3.

## Context
Phase 1 proposed NestJS for its module structure and OpenAPI generation, with a note that the choice would be validated in Phase 2. The data layer is plain SQL with per-request database context (row-level security), validation uses zod, and tests run through Vitest.

## Decision
Use **Fastify 5** with explicit modules (plugins), zod for validation, and hand-written guards.

## Why
- NestJS relies on decorator metadata and dependency injection. Vitest (esbuild) does not emit decorator metadata without an extra SWC plugin, so every test setup would carry non-trivial tooling for a solo maintainer.
- The security-critical logic here (session loading, tenant resolution, permission checks) is clearer as small explicit functions than as framework-injected guards.
- Fastify has first-class request-id, logging with redaction, rate limiting, cookies and helmet.
- Module boundaries are still enforced by folder structure and, later, lint rules, as ARCHITECTURE.md requires.

## Consequences
- OpenAPI generation must come from the zod schemas (e.g. via a zod-to-OpenAPI adapter) instead of decorators. Scheduled for when the first public endpoints stabilize.
- No dependency-injection container: dependencies are passed explicitly (`Deps`), which also keeps tests simple.
- If the team grows and prefers NestJS conventions, the service logic is framework-independent enough to move.
