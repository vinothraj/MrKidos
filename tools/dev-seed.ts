/**
 * Seeds the local development database with one account per role, a community and a vendor, so every part of the app can be
 * tried without registering and promoting people by hand. Idempotent. Development only: tools/stack.ts runs it in dev mode.
 * It uses the admin connection (row-level security does not apply), exactly like the e2e fixtures do.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "../apps/api/src/auth/password";
import { DEV_ACCOUNTS, DEV_COMMUNITY_NAME, DEV_PASSWORD, DEV_VENDOR_NAME, PLATFORM_ORG_ID, type DevAccount } from "../apps/api/src/dev-accounts";

async function ensureOrg(admin: Pool, type: "community" | "vendor", name: string): Promise<string> {
  const found = await admin.query<{ id: string }>("SELECT id FROM organizations WHERE type = $1 AND name = $2", [type, name]);
  if (found.rows[0]) return found.rows[0].id;
  const id = randomUUID();
  await admin.query("INSERT INTO organizations (id, type, name, status) VALUES ($1, $2, $3, 'active')", [id, type, name]);
  if (type === "community") {
    await admin.query("INSERT INTO community_profiles (tenant_id, city, locality, unit_count) VALUES ($1, 'Bengaluru', 'Whitefield', 240) ON CONFLICT DO NOTHING", [id]);
  } else {
    await admin.query(
      "INSERT INTO vendor_profiles (tenant_id, business_type, tagline, city) VALUES ($1, 'business', 'Hands-on science for curious kids', 'Bengaluru') ON CONFLICT DO NOTHING",
      [id],
    );
  }
  return id;
}

async function ensureUser(admin: Pool, a: DevAccount, passwordHash: string): Promise<string> {
  const found = await admin.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [a.email]);
  let id = found.rows[0]?.id;
  if (!id) {
    id = randomUUID();
    await admin.query("INSERT INTO users (id, email, display_name, email_verified_at) VALUES ($1, $2, $3, now())", [id, a.email, a.displayName]);
  }
  // Re-applied on every start so the password shown in the login panel always works, even after a lockout.
  await admin.query(
    `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL`,
    [id, passwordHash],
  );
  await admin.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), status = 'active' WHERE id = $1", [id]);
  return id;
}

/** Prices are stored in paise (minor units). */
const OFFERINGS = [
  {
    name: "Kitchen Science Show",
    category: "science_workshops",
    type: "workshop",
    pricing: "per_event",
    priceMinor: 600_000,
    minutes: 60,
    min: 8,
    max: 40,
    ageMin: 5,
    ageMax: 12,
    description: "A lively 60-minute show with safe experiments from the kitchen cupboard: fizzing volcanoes, colour-changing cabbage juice and a giant bubble. Every child gets to join in.",
    equipment: "We bring everything. A table and a power socket are all we need.",
    venue: "A hall, clubhouse or large room with a table.",
    cancellation: "Free to cancel up to 3 days before. Half the fee after that.",
  },
  {
    name: "Junior Robotics Workshop",
    category: "robotics_stem",
    type: "workshop",
    pricing: "per_participant",
    priceMinor: 45_000,
    minutes: 90,
    min: 6,
    max: 20,
    ageMin: 8,
    ageMax: 14,
    description: "Children build and program a small robot in teams of two and finish with a friendly obstacle race. No experience needed.",
    equipment: "Robot kits for every pair, laptops and a projector.",
    venue: "A room with tables and enough space for a small race track.",
    cancellation: "Free to cancel up to 5 days before.",
  },
  {
    name: "Stargazing Evening",
    category: "astronomy",
    type: "experience",
    pricing: "fixed",
    priceMinor: 350_000,
    minutes: 120,
    min: 10,
    max: 60,
    ageMin: 6,
    ageMax: 16,
    description: "An evening on the terrace with two telescopes and a guided tour of the planets, the moon and the brightest constellations.",
    equipment: "Two telescopes, star charts and red torches.",
    venue: "An open terrace or ground with a clear view of the sky.",
    cancellation: "Rescheduled free of charge if the sky is cloudy.",
  },
] as const;

const REQUIRED_DOCS = [
  ["identity_proof", "Aadhaar sighted by the platform team"],
  ["background_check", "Police verification certificate"],
  ["child_safety_training", "Child-safety briefing certificate"],
] as const;

/** Makes the demo vendor a real, approved vendor: vetted, serving the community, approved by it, with published offerings. */
async function seedVendorCatalog(admin: Pool, communityId: string, vendorId: string, reviewerId: string): Promise<void> {
  for (const [key, title] of REQUIRED_DOCS) {
    const have = await admin.query("SELECT 1 FROM vendor_documents WHERE tenant_id = $1 AND requirement_key = $2", [vendorId, key]);
    if (!have.rowCount) {
      await admin.query(
        `INSERT INTO vendor_documents (tenant_id, requirement_key, title, reference, issued_on, expires_on, status, reviewed_by, reviewed_at, review_note, created_by)
         VALUES ($1, $2, $3, 'Dev demo record', current_date - 30, current_date + 700, 'verified', $4, now(), 'Checked for the demo.', $4)`,
        [vendorId, key, title, reviewerId],
      );
    }
  }
  await admin.query("SELECT refresh_vendor_vetting($1)", [vendorId]);
  await admin.query(
    "INSERT INTO vendor_service_areas (tenant_id, community_id, travel_fee_minor, travel_note) VALUES ($1, $2, 50000, 'Nearby, so a small travel fee.') ON CONFLICT DO NOTHING",
    [vendorId, communityId],
  );
  await admin.query(
    `INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status, note, decided_by) VALUES ($1, $2, 'approved', 'Approved for the demo.', $3)
     ON CONFLICT (tenant_id, vendor_id) DO UPDATE SET status = 'approved'`,
    [communityId, vendorId, reviewerId],
  );
  for (const key of ["science_workshops", "robotics_stem", "astronomy"]) {
    await admin.query("INSERT INTO vendor_categories (tenant_id, category_id) SELECT $1, id FROM categories WHERE key = $2 ON CONFLICT DO NOTHING", [vendorId, key]);
  }
  const hours = await admin.query("SELECT 1 FROM vendor_availability_rules WHERE tenant_id = $1", [vendorId]);
  if (!hours.rowCount) {
    for (const weekday of [0, 6]) await admin.query("INSERT INTO vendor_availability_rules (tenant_id, weekday, start_time, end_time) VALUES ($1, $2, '10:00', '18:00')", [vendorId, weekday]);
    for (const weekday of [1, 2, 3, 4, 5]) await admin.query("INSERT INTO vendor_availability_rules (tenant_id, weekday, start_time, end_time) VALUES ($1, $2, '16:00', '19:00')", [vendorId, weekday]);
  }
  await admin.query(
    `UPDATE vendor_profiles SET description = $2, tagline = 'Hands-on science for curious kids', city = 'Bengaluru', locality = 'Whitefield', years_experience = 7,
            business_type = 'business', country = 'India', state = 'Karnataka' WHERE tenant_id = $1`,
    [vendorId, "We are a small team of former teachers and engineers who bring safe, hands-on science, robotics and astronomy to apartment communities and schools."],
  );
  for (const o of OFFERINGS) {
    const have = await admin.query("SELECT 1 FROM offerings WHERE tenant_id = $1 AND name = $2", [vendorId, o.name]);
    if (have.rowCount) continue;
    await admin.query(
      `INSERT INTO offerings (tenant_id, category_id, name, description, offering_type, pricing_model, price_minor, duration_minutes, min_participants, max_participants,
                              age_min, age_max, equipment, venue_requirements, cancellation_policy, status)
       SELECT $1, c.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'published' FROM categories c WHERE c.key = $2`,
      [vendorId, o.category, o.name, o.description, o.type, o.pricing, o.priceMinor, o.minutes, o.min, o.max, o.ageMin, o.ageMax, o.equipment, o.venue, o.cancellation],
    );
  }
}

export async function seedDevData(admin: Pool): Promise<void> {
  const community = await ensureOrg(admin, "community", DEV_COMMUNITY_NAME);
  const vendor = await ensureOrg(admin, "vendor", DEV_VENDOR_NAME);
  const tenants = { platform: PLATFORM_ORG_ID, community, vendor } as const;
  const passwordHash = await hashPassword(DEV_PASSWORD);

  let reviewerId = "";
  for (const a of DEV_ACCOUNTS) {
    const userId = await ensureUser(admin, a, passwordHash);
    if (a.key === "vendor-manager") reviewerId = userId;
    const tenant = tenants[a.scope];
    if (a.scope === "platform") await admin.query("INSERT INTO platform_staff (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    await admin.query("INSERT INTO memberships (tenant_id, user_id, status) VALUES ($1, $2, 'active') ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'", [tenant, userId]);
    for (const role of a.roles) {
      await admin.query(
        "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL ON CONFLICT DO NOTHING",
        [tenant, userId, role],
      );
    }
  }
  await seedVendorCatalog(admin, community, vendor, reviewerId);
}
