/**
 * Local-development accounts, one per role, used by the quick-login panel and by tools/dev-seed.ts.
 * Development only: the seed and the login route are wired in by tools/stack.ts (dev mode) and nowhere else.
 */
export const DEV_PASSWORD = "Kidos-dev-login-2026";
export const DEV_EMAIL_DOMAIN = "dev.kidos.test";
export const PLATFORM_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_COMMUNITY_NAME = "Sunrise Heights (dev)";
export const DEV_VENDOR_NAME = "Little Scientists (dev)";

export type DevScope = "platform" | "community" | "vendor";

export interface DevAccount {
  key: string;
  email: string;
  displayName: string;
  /** Short title shown on the button. */
  label: string;
  /** What this person can do, in plain words. */
  description: string;
  scope: DevScope;
  /** System role keys held in the organization of `scope` (none for a plain family account). */
  roles: string[];
}

const acct = (key: string, displayName: string, label: string, description: string, scope: DevScope, roles: string[]): DevAccount => ({
  key,
  email: `${key}@${DEV_EMAIL_DOMAIN}`,
  displayName,
  label,
  description,
  scope,
  roles,
});

export const DEV_ACCOUNTS: readonly DevAccount[] = [
  acct("super-admin", "Sam Super", "Platform super admin", "Every permission: communities, vendors, vetting, requests, audit.", "platform", ["super_admin"]),
  acct("platform-admin", "Pia Platform", "Platform administrator", "Runs the platform: communities, vendors, requests.", "platform", ["platform_admin"]),
  acct("operations", "Omar Operations", "Business operations", "The operations desk: requests, sourcing, bookings.", "platform", ["business_operations"]),
  acct("vendor-manager", "Vera Vendors", "Vendor manager", "Vendor registration and vetting.", "platform", ["vendor_manager"]),
  acct("support", "Sana Support", "Customer support", "Support desk and concerns.", "platform", ["customer_support"]),
  acct("community-admin", "Chitra Community", "Community administrator", `Administers ${DEV_COMMUNITY_NAME}: members, invite codes, policies.`, "community", ["community_admin"]),
  acct("resident", "Priya Resident", "Resident and parent", `A family in ${DEV_COMMUNITY_NAME}: browse, request, book.`, "community", ["resident", "parent_guardian"]),
  acct("vendor-owner", "Vikram Vendor", "Vendor owner", `Owns ${DEV_VENDOR_NAME}: profile, offerings, quotes.`, "vendor", ["vendor_owner"]),
  acct("vendor-staff", "Vani Staff", "Vendor staff", `Works for ${DEV_VENDOR_NAME}.`, "vendor", ["vendor_staff"]),
];

export const isDevEmail = (email: string): boolean => DEV_ACCOUNTS.some((a) => a.email === email);
