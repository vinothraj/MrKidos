import type { Pool } from "pg";
import type { AppConfig } from "./config";
import type { Mailer } from "./mailer";

export interface Deps {
  pool: Pool;
  config: AppConfig;
  mailer: Mailer;
}

export interface AuthState {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  activeTenantId: string | null;
  emailVerified: boolean;
  /** The second factor has been verified for this session. */
  mfaVerified: boolean;
  /** Password was accepted but the second factor is still outstanding (only reachable on routes that allow it). */
  mfaPending: boolean;
}

/** Resolved tenant context for the current request. */
export interface TenantState {
  tenantId: string;
  userId: string;
  platformScope: boolean;
  permissions: ReadonlySet<string>;
  /** The user holds a role here that requires MFA, but this session has not completed MFA. */
  mfaEnrollmentRequired: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthState;
    tenantState?: TenantState;
  }
}

/** Well-known id of the platform organization seeded by migration 0003. */
export const PLATFORM_ORG_ID = "00000000-0000-4000-8000-000000000001";
