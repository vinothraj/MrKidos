-- 0017: indexes for the "newest first" lists that operations reads across every community.
--
-- Found by the load check (tools/load-check.ts) with 30 communities, 30,000 requests and 300,000 audit rows:
-- the platform-wide audit trail took about 2.7 s and the operations request queue about 0.3 s, because both are
-- ordered by (created_at, id) across all tenants and the only indexes start with tenant_id (or status), so the
-- database read and sorted every row. With these indexes the same pages take about a millisecond.
--
-- Additive only: no table, policy or grant changes. A community-scoped reader is unaffected (its queries are narrowed
-- by row-level security and by the existing tenant-first indexes).
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX requests_created_idx ON requests (created_at DESC, id DESC);
