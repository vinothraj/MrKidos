import type { PoolClient } from "pg";
import type { AppConfig } from "./config";
import { trySend, type MailMessage } from "./mailer";
import type { Deps } from "./types";

/**
 * Email notifications for the events people otherwise only discover by opening the app.
 *
 * They are deliberately minimal: a subject, one sentence and a link. No names, prices, children's details or request
 * text ever go into an email (email is not a secure channel, and it is kept by third parties). Messages are collected
 * during the transaction and sent only AFTER it commits, so a rolled-back action never emails anyone, and a failure to
 * send never breaks the action (it is logged).
 */
export class Outbox {
  private readonly messages: MailMessage[] = [];
  constructor(
    private readonly deps: Deps,
    private readonly log: { error: (obj: object, msg: string) => void },
  ) {}

  /** Queue an event email for each address (duplicates collapsed). */
  event(config: AppConfig, to: (string | null | undefined)[], subject: string, sentence: string, path: string): void {
    for (const address of new Set(to.filter((x): x is string => typeof x === "string" && x.length > 0))) {
      this.messages.push({
        to: address,
        subject: `${subject} (${config.brandName})`,
        text: `${sentence}\n\nOpen ${config.brandName}:\n${config.appBaseUrl}${path}\n\nYou receive this because of your role on ${config.brandName}.`,
      });
    }
  }

  /** Send everything queued. Call after the transaction has committed. */
  async flush(): Promise<void> {
    const batch = this.messages.splice(0);
    await Promise.all(batch.map((m) => trySend(this.deps.mailer, m, this.log)));
  }
}

/** Verified, active people on a vendor's team whose role carries `permission`. Read in a context that may see them (operations). */
export async function vendorTeamEmails(c: PoolClient, vendorId: string, permission: string): Promise<string[]> {
  const res = await c.query<{ email: string }>(
    `SELECT DISTINCT u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN role_assignments ra ON ra.tenant_id = m.tenant_id AND ra.user_id = m.user_id
       JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission_code = $2
      WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL`,
    [vendorId, permission],
  );
  return res.rows.map((r) => r.email);
}

/** One verified, active person's address. Read in a context that may see them (operations). */
export async function userEmail(c: PoolClient, userId: string): Promise<string | null> {
  const res = await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND email_verified_at IS NOT NULL", [userId]);
  return res.rows[0]?.email ?? null;
}
