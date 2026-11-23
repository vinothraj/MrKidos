-- 0022 Covering index for the operations desk's counts.
--
-- "Queue summary" and "Waiting for you" count requests by status, owner and target time across every community. They
-- read only these columns (plus tenant_id and requester_id, which the row-level security check on `requests` reads),
-- so an index holding exactly them lets the database count without visiting each request row (an index-only scan).
-- No policy, grant or data changes. Replaces nothing; the existing indexes still serve the lists.

CREATE INDEX requests_summary_idx ON requests (status) INCLUDE (tenant_id, requester_id, assigned_to, sla_due_at);
