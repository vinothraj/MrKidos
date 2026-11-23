import type { PoolClient } from "pg";

/**
 * Vendor matching, version 1. Two separate questions:
 *
 *  1. ELIGIBILITY (safety, not preference): only vendors a family in this community could be offered. It must agree with
 *     what the catalog shows residents: active, serving the community, current vetting, and approved by the community
 *     unless the community turned that requirement off. A test compares the two so they cannot drift apart.
 *  2. SCORE (preference): how well an eligible vendor's offerings fit the request, with a reason for every point added or
 *     taken away, so the operations team can see why and can override with a logged reason.
 */
export const WEIGHTS_VERSION = 1;

export interface RequestFacts {
  id: string;
  tenantId: string;
  categoryId: string | null;
  preferredDate: string | null; // yyyy-mm-dd
  participantCount: number | null;
  ageMin: number | null;
  ageMax: number | null;
  budgetMaxMinor: number | null;
}

export interface EligibleVendor {
  id: string;
  name: string;
  yearsExperience: number | null;
  travelFeeMinor: number;
}

export interface Reason {
  points: number;
  text: string;
}
export interface Match {
  vendorId: string;
  vendorName: string;
  offeringId: string | null;
  offeringName: string | null;
  score: number;
  reasons: Reason[];
}

export async function eligibleVendors(c: PoolClient, communityId: string): Promise<EligibleVendor[]> {
  const res = await c.query<{ id: string; name: string; years_experience: number | null; travel_fee_minor: string }>(
    `SELECT v.id, v.name, vp.years_experience, sa.travel_fee_minor::text AS travel_fee_minor
       FROM organizations v
       JOIN vendor_profiles vp ON vp.tenant_id = v.id
       JOIN vendor_service_areas sa ON sa.tenant_id = v.id AND sa.community_id = $1
       JOIN vendor_vetting_summary s ON s.tenant_id = v.id AND s.complete AND (s.valid_until IS NULL OR s.valid_until >= current_date)
      WHERE v.type = 'vendor' AND v.status = 'active'
        AND (NOT COALESCE((SELECT p.value = 'true'::jsonb FROM community_policies p WHERE p.tenant_id = $1 AND p.key = 'vendor_approval_required'), true)
             OR EXISTS (SELECT 1 FROM community_vendor_approvals a WHERE a.tenant_id = $1 AND a.vendor_id = v.id AND a.status = 'approved'))
      ORDER BY v.name`,
    [communityId],
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name, yearsExperience: r.years_experience, travelFeeMinor: Number(r.travel_fee_minor) }));
}

interface OfferingRow {
  id: string;
  vendor_id: string;
  name: string;
  category_id: string;
  parent_id: string | null;
  pricing_model: string;
  price_minor: string | null;
  duration_minutes: number | null;
  min_participants: number | null;
  max_participants: number | null;
  age_min: number | null;
  age_max: number | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Price of an offering for this request in minor units, or null when it is quoted on request. */
function estimatePrice(o: OfferingRow, count: number | null): number | null {
  if (o.price_minor === null || o.pricing_model === "custom_quotation") return null;
  const price = Number(o.price_minor);
  if (o.pricing_model === "per_participant") return price * (count ?? 1);
  if (o.pricing_model === "hourly") return Math.round(price * ((o.duration_minutes ?? 60) / 60));
  return price;
}

export async function scoreVendors(c: PoolClient, request: RequestFacts, vendors: EligibleVendor[]): Promise<Match[]> {
  if (vendors.length === 0) return [];
  const ids = vendors.map((v) => v.id);
  const offerings = (
    await c.query<OfferingRow>(
      `SELECT o.id, o.tenant_id AS vendor_id, o.name, o.category_id, cat.parent_id, o.pricing_model, o.price_minor::text AS price_minor, o.duration_minutes,
              o.min_participants, o.max_participants, o.age_min, o.age_max
         FROM offerings o JOIN categories cat ON cat.id = o.category_id WHERE o.tenant_id = ANY($1) AND o.status = 'published'`,
      [ids],
    )
  ).rows;
  const listed = (await c.query<{ tenant_id: string; category_id: string }>("SELECT tenant_id, category_id FROM vendor_categories WHERE tenant_id = ANY($1)", [ids])).rows;
  const requestCat = request.categoryId
    ? (await c.query<{ parent_id: string | null; name: string }>("SELECT parent_id, name FROM categories WHERE id = $1", [request.categoryId])).rows[0]
    : undefined;
  const weekly = (await c.query<{ tenant_id: string; weekday: number }>("SELECT DISTINCT tenant_id, weekday FROM vendor_availability_rules WHERE tenant_id = ANY($1)", [ids])).rows;
  let weekday: number | null = null;
  let blocked = new Set<string>();
  if (request.preferredDate) {
    weekday = (await c.query<{ d: number }>("SELECT extract(dow FROM $1::date)::int AS d", [request.preferredDate])).rows[0]?.d ?? null;
    blocked = new Set(
      (
        await c.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM vendor_unavailable_blocks WHERE tenant_id = ANY($1) AND starts_at < ($2::date + 1) AND ends_at > $2::date",
          [ids, request.preferredDate],
        )
      ).rows.map((r) => r.tenant_id),
    );
  }

  const out: Match[] = [];
  for (const v of vendors) {
    const mine = offerings.filter((o) => o.vendor_id === v.id);
    const options: (OfferingRow | null)[] = mine.length > 0 ? mine : [null];
    let best: Match | undefined;
    for (const o of options) {
      const reasons: Reason[] = [{ points: 20, text: "Serves your community, is approved and its documents are current" }];
      const add = (points: number, text: string) => reasons.push({ points, text });

      if (!request.categoryId) add(10, "No category was chosen, so every vendor is considered");
      else if (o && o.category_id === request.categoryId) add(40, "Offers exactly this category");
      else if (o && requestCat?.parent_id && o.parent_id === requestCat.parent_id) add(20, "Offers something in the same area");
      else if (listed.some((l) => l.tenant_id === v.id && l.category_id === request.categoryId)) add(15, "Lists this category");
      else add(0, "Does not offer this category");

      if (o && (request.ageMin !== null || request.ageMax !== null)) {
        const lo = request.ageMin ?? 0;
        const hi = request.ageMax ?? 100;
        if (o.age_min === null && o.age_max === null) add(5, "No age limits stated");
        else if ((o.age_min ?? 0) <= hi && (o.age_max ?? 100) >= lo) add(15, "Suitable for the children's ages");
        else add(-20, "The age range does not overlap");
      }
      if (o && request.participantCount !== null) {
        const n = request.participantCount;
        const fits = (o.min_participants === null || n >= o.min_participants) && (o.max_participants === null || n <= o.max_participants);
        add(fits ? 10 : -10, fits ? "Handles this many children" : "Group size is outside what it offers");
      }
      if (o && request.budgetMaxMinor !== null) {
        const price = estimatePrice(o, request.participantCount);
        if (price === null) add(5, "Quotes on request, so the price is not known yet");
        else if (price <= request.budgetMaxMinor) add(15, "Within the budget");
        else if (price <= request.budgetMaxMinor * 1.2) add(5, "Slightly over the budget");
        else add(-15, "Over the budget");
      }
      if (request.preferredDate && weekday !== null) {
        const hasHours = weekly.some((w) => w.tenant_id === v.id);
        if (blocked.has(v.id)) add(-30, "Marked as unavailable on the preferred date");
        else if (!hasHours) add(0, "No weekly hours set, availability unknown");
        else if (weekly.some((w) => w.tenant_id === v.id && w.weekday === weekday)) add(10, "Works on that day of the week");
        else add(-10, "Does not usually work on that day of the week");
      }
      if ((v.yearsExperience ?? 0) >= 5) add(5, "Five or more years of experience");

      const score = clamp(reasons.reduce((s, r) => s + r.points, 0));
      const candidate: Match = { vendorId: v.id, vendorName: v.name, offeringId: o?.id ?? null, offeringName: o?.name ?? null, score, reasons };
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || a.vendorName.localeCompare(b.vendorName));
}
