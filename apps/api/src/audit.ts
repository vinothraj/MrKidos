import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Appends an audit record using the caller's client, so the entry commits or rolls back together with the change it describes.
 * Never put secrets or raw personal data in metadata.
 */
export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      entry.tenantId ?? null,
      entry.actorUserId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.requestId ?? null,
    ],
  );
}

/** Stable, non-reversible reference for an email, for audit trails of anonymous events (e.g. failed logins). */
export function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}
