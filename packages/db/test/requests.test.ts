import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createTestDb, type TestDb } from "../src/testing";

/**
 * The request workflow as the database enforces it, attacked the way a hostile client would: skipping steps,
 * acting for someone else, editing the SLA clock, reading internal notes.
 */
const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";
let db: TestDb;
let community: string;
let otherCommunity: string;
let resident: string; // requester, member of `community`
let neighbour: string; // another member of `community`
let stranger: string; // not a member
let admin: string; // community administrator (reads, never changes)
let ops: string; // operations team member
let ops2: string;

const RESIDENT_PERMS = ["requests.create_own", "requests.read_own", "requests.cancel_own", "requests.comment_public"];
const STAFF_PERMS = ["requests.read_all", "requests.transition", "requests.assign", "requests.comment_public", "requests.comment_internal"];
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

const asResident = (userId = resident, tenantId = community) => ({ tenantId, userId, permissions: RESIDENT_PERMS });
const asAdmin = () => ({ tenantId: community, userId: admin, permissions: ["requests.read_community", "communities.read"] });
const asOps = (permissions: string[] = STAFF_PERMS, userId = ops) => ({ tenantId: community, userId, platformScope: true, permissions });

/** Runs a statement with a transition note available to the workflow trigger, as the API does. */
const withNote = async (c: PoolClient, note: string | null) => {
  if (note !== null) await c.query("SELECT set_config('app.note', $1, true)", [note]);
};

async function newRequest(who = resident, tenant = community): Promise<string> {
  return withContext(db.app, asResident(who, tenant), async (c) =>
    (await c.query<{ id: string }>(
      "INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Magic show') RETURNING id",
      [tenant, who],
    )).rows[0]?.id as string,
  );
}
const status = async (id: string) => (await q("SELECT status, sla_due_at, assigned_to FROM requests WHERE id = $1", [id])).rows[0] as { status: string; sla_due_at: Date | null; assigned_to: string | null };
const hours = (d: Date | null) => (d ? Math.round((d.getTime() - Date.now()) / 3_600_000) : null);

async function move(id: string, to: string, ctx: Parameters<typeof withContext>[1], note: string | null = null) {
  return withContext(db.app, ctx, async (c) => {
    await withNote(c, note);
    return c.query("UPDATE requests SET status = $2 WHERE id = $1", [id, to]);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  [community, otherCommunity, resident, neighbour, stranger, admin, ops, ops2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await q("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', 'Request Heights', 'active'), ($2, 'community', 'Other Heights', 'active')", [community, otherCommunity]);
  for (const [id, n] of [[resident, "res"], [neighbour, "nei"], [stranger, "str"], [admin, "adm"], [ops, "ops"], [ops2, "ops2"]] as const) {
    await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${n}@requests.test`, n]);
  }
  await q("INSERT INTO platform_staff (user_id) VALUES ($1), ($2)", [ops, ops2]);
  for (const id of [ops, ops2]) {
    await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [PLATFORM_ORG, id]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'business_operations' AND tenant_id IS NULL", [PLATFORM_ORG, id]);
  }
  for (const id of [resident, neighbour, admin]) await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, id]);
  for (const id of [resident, neighbour]) await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [community, id]);
  // the stranger is a resident of ANOTHER community only
  await q("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [otherCommunity, stranger]);
  await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [otherCommunity, stranger]);
});
afterAll(async () => {
  await db.close();
});

describe("creating a request", () => {
  it("lets a member create their own request: submitted, with a first-response target and a history row", async () => {
    const id = await newRequest();
    const row = await status(id);
    expect(row.status).toBe("submitted");
    expect(hours(row.sla_due_at)).toBe(24);
    const history = (await q("SELECT from_status, to_status, changed_by FROM request_status_history WHERE request_id = $1", [id])).rows;
    expect(history).toEqual([{ from_status: null, to_status: "submitted", changed_by: resident }]);
  });

  it("refuses requests made for someone else, in another community, by non-members, in another status, or with a pre-assigned owner", async () => {
    const insert = (c: PoolClient, over: { tenant?: string; requester?: string; status?: string; assigned?: string | null } = {}) =>
      c.query(
        "INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status, assigned_to) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'x y z', $3, $4) RETURNING assigned_to",
        [over.tenant ?? community, over.requester ?? resident, over.status ?? "submitted", over.assigned ?? null],
      );
    await expect(withContext(db.app, asResident(), (c) => insert(c, { requester: neighbour }))).rejects.toMatchObject({ code: "42501" }); // as someone else
    await expect(withContext(db.app, asResident(), (c) => insert(c, { tenant: otherCommunity }))).rejects.toMatchObject({ code: "42501" }); // for a community they are not acting in
    await expect(withContext(db.app, asResident(stranger), (c) => insert(c, { requester: stranger }))).rejects.toMatchObject({ code: "42501" }); // not a member of this community
    await expect(withContext(db.app, asResident(), (c) => insert(c, { status: "approved" }))).rejects.toMatchObject({ code: "42501" }); // cannot start approved
    await expect(withContext(db.app, { tenantId: community, userId: resident, permissions: [] }, (c) => insert(c))).resolves.toBeDefined(); // permission is table-derived (role), not the list
    // a pre-assigned owner is silently dropped
    const row = await withContext(db.app, asResident(), async (c) => (await insert(c, { assigned: ops })).rows[0]);
    expect(row.assigned_to).toBeNull();
    // an inactive community takes no requests
    await q("UPDATE organizations SET status = 'suspended' WHERE id = $1", [community]);
    try {
      await expect(withContext(db.app, asResident(), (c) => insert(c))).rejects.toMatchObject({ code: "42501" });
    } finally {
      await q("UPDATE organizations SET status = 'active' WHERE id = $1", [community]);
    }
  });
});

describe("defence in depth", () => {
  it("refuses a request from a member whose membership is no longer active, even though they still hold the resident role", async () => {
    const lapsed = randomUUID();
    await q("INSERT INTO users (id, email, display_name) VALUES ($1, 'lapsed@requests.test', 'lapsed')", [lapsed]);
    await q("INSERT INTO memberships (tenant_id, user_id, status) VALUES ($1, $2, 'suspended')", [community, lapsed]);
    await q("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'resident' AND tenant_id IS NULL", [community, lapsed]);
    await expect(newRequest(lapsed)).rejects.toMatchObject({ code: "42501" });
    await q("UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2", [community, lapsed]);
    await expect(newRequest(lapsed)).resolves.toBeDefined(); // the same person, once active again
  });

  it("the workflow trigger itself refuses a requester step by someone else, even when row security is out of the way", async () => {
    const id = await newRequest();
    // The admin connection bypasses row-level security (as a table owner or a bug might); the trigger is the second wall.
    const ctx = { tenantId: community, userId: neighbour, permissions: RESIDENT_PERMS };
    await expect(withContext(db.admin, ctx, (c) => c.query("UPDATE requests SET status = 'cancelled' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    expect((await status(id)).status).toBe("submitted");
    // the requester themselves, through the same path, may
    await withContext(db.admin, asResident(), (c) => c.query("UPDATE requests SET status = 'cancelled' WHERE id = $1", [id]));
    expect((await status(id)).status).toBe("cancelled");
  });
});

describe("who can see a request", () => {
  it("is the requester, the community's request readers, and the platform; nobody else", async () => {
    const id = await newRequest();
    const count = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT 1 FROM requests WHERE id = $1", [id])).rowCount);
    expect(await count(asResident())).toBe(1);
    expect(await count(asAdmin())).toBe(1);
    expect(await count(asOps())).toBe(1);
    expect(await count(asResident(neighbour))).toBe(0); // a neighbour in the same community
    expect(await count({ tenantId: community, userId: neighbour, permissions: ["requests.read_community"] })).toBe(1); // ...unless they hold the reader permission here
    expect(await count(asResident(stranger, otherCommunity))).toBe(0); // another community
    expect(await count({ tenantId: otherCommunity, userId: admin, permissions: ["requests.read_community"] })).toBe(0); // an administrator elsewhere
    expect(await count({ userId: resident })).toBe(0); // no community context
    expect(await count({ tenantId: community, userId: ops, permissions: STAFF_PERMS })).toBe(0); // platform staff NOT in platform scope are ordinary people
  });
});

describe("the workflow is enforced by the database", () => {
  it("lets operations move a request along the defined steps only, restarting the target clock each time", async () => {
    const id = await newRequest();
    await move(id, "under_review", asOps());
    expect(hours((await status(id)).sla_due_at)).toBe(48);
    await move(id, "information_required", asOps(), "Which date works best?");
    expect(hours((await status(id)).sla_due_at)).toBe(120);
    await move(id, "under_review", asOps());
    await move(id, "approved", asOps());
    expect((await status(id)).sla_due_at).toBeNull(); // no target for this step
    const history = (await q("SELECT from_status, to_status, note, changed_by FROM request_status_history WHERE request_id = $1 ORDER BY created_at, to_status", [id])).rows;
    expect(history.map((h) => h.to_status).sort()).toEqual(["approved", "information_required", "submitted", "under_review", "under_review"].sort());
    expect(history.find((h) => h.to_status === "information_required")).toMatchObject({ from_status: "under_review", note: "Which date works best?", changed_by: ops });
  });

  it("refuses steps the workflow does not define, and any move out of a finished request", async () => {
    const id = await newRequest();
    for (const to of ["approved", "closed", "confirmed", "nonsense"]) {
      await expect(move(id, to, asOps()), to).rejects.toThrow();
    }
    expect((await status(id)).status).toBe("submitted");
    await move(id, "rejected", asOps(), "Out of our area.");
    await expect(move(id, "under_review", asOps())).rejects.toMatchObject({ code: "42501" }); // terminal
    await expect(move(id, "submitted", asOps())).rejects.toMatchObject({ code: "42501" });
  });

  it("needs the permission for the step, not just platform scope", async () => {
    const id = await newRequest();
    await expect(move(id, "under_review", asOps(["requests.read_all"]))).rejects.toMatchObject({ code: "42501" });
    expect((await move(id, "under_review", { tenantId: community, userId: ops, permissions: STAFF_PERMS })).rowCount).toBe(0); // permissions without platform scope: the row is not even visible
    expect((await status(id)).status).toBe("submitted");
    await move(id, "under_review", asOps(["requests.transition"]));
  });

  it("requires a note where the workflow says so (rejecting, asking for information, closing)", async () => {
    const id = await newRequest();
    await move(id, "under_review", asOps());
    for (const to of ["information_required", "rejected"]) {
      await expect(move(id, to, asOps()), to).rejects.toMatchObject({ code: "23514" });
      await expect(move(id, to, asOps(), "   "), `${to} blank`).rejects.toMatchObject({ code: "23514" });
    }
    expect((await status(id)).status).toBe("under_review");
  });

  it("lets only the requester cancel, only while the request is open, and never lets them advance it", async () => {
    const id = await newRequest();
    await expect(move(id, "under_review", asResident())).rejects.toMatchObject({ code: "42501" }); // cannot start their own review
    await expect(move(id, "approved", asResident())).rejects.toMatchObject({ code: "42501" });
    // a neighbour cannot even see it, so nothing happens
    expect((await move(id, "cancelled", asResident(neighbour))).rowCount).toBe(0);
    // a community administrator reads but cannot change
    expect((await move(id, "cancelled", asAdmin())).rowCount).toBe(0);
    expect((await status(id)).status).toBe("submitted");
    await move(id, "cancelled", asResident());
    expect((await status(id)).status).toBe("cancelled");
    await expect(move(id, "submitted", asResident())).rejects.toMatchObject({ code: "42501" }); // cannot reopen
    // a rejected request cannot be "cancelled" away to hide the rejection
    const other = await newRequest();
    await move(other, "rejected", asOps(), "No.");
    await expect(move(other, "cancelled", asResident())).rejects.toMatchObject({ code: "42501" });
  });

  it("lets the requester reply to a question (information required back to review) but not skip ahead", async () => {
    const id = await newRequest();
    await move(id, "under_review", asOps());
    await move(id, "information_required", asOps(), "What age group?");
    await expect(move(id, "approved", asResident())).rejects.toMatchObject({ code: "42501" });
    await move(id, "under_review", asResident());
    expect((await status(id)).status).toBe("under_review");
    expect((await q("SELECT changed_by FROM request_status_history WHERE request_id = $1 AND from_status = 'information_required'", [id])).rows[0]).toEqual({ changed_by: resident });
  });

  it("cannot be edited around: the clock fields are not settable, ownership is operations-only", async () => {
    const id = await newRequest();
    const before = await status(id);
    await withContext(db.app, asResident(), (c) => c.query("UPDATE requests SET sla_due_at = now() + interval '5 years', status_changed_at = now() - interval '1 year' WHERE id = $1", [id]));
    expect((await status(id)).sla_due_at?.getTime()).toBe(before.sla_due_at?.getTime());
    await expect(withContext(db.app, asResident(), (c) => c.query("UPDATE requests SET assigned_to = $2 WHERE id = $1", [id, ops]))).rejects.toMatchObject({ code: "42501" });
    // title, description and the rest are not updatable by anyone through the application role
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET title = 'changed' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withContext(db.app, asOps(), (c) => c.query("DELETE FROM requests WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("assigns only to operations team members, and only with the permission", async () => {
    const id = await newRequest();
    await withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET assigned_to = $2 WHERE id = $1", [id, ops]));
    expect((await status(id)).assigned_to).toBe(ops);
    await withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET assigned_to = $2 WHERE id = $1", [id, ops2])); // reassign
    await withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET assigned_to = NULL WHERE id = $1", [id]));
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE requests SET assigned_to = $2 WHERE id = $1", [id, resident]))).rejects.toMatchObject({ code: "23514" }); // a resident is not on the team
    await expect(withContext(db.app, asOps(["requests.transition"]), (c) => c.query("UPDATE requests SET assigned_to = $2 WHERE id = $1", [id, ops]))).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps the history append-only", async () => {
    const id = await newRequest();
    await expect(q("UPDATE request_status_history SET note = 'rewritten' WHERE request_id = $1", [id])).rejects.toThrow();
    await expect(q("DELETE FROM request_status_history WHERE request_id = $1", [id])).rejects.toThrow();
    await expect(withContext(db.app, asOps(), (c) => c.query("UPDATE request_status_history SET note = 'x'"))).rejects.toThrow();
    await expect(withContext(db.app, asResident(), (c) => c.query("INSERT INTO request_status_history (tenant_id, request_id, to_status, note) VALUES ($1, $2, 'approved', 'forged')", [community, id]))).resolves.toBeDefined(); // own request: allowed to append...
    // ...but a neighbour cannot forge history on someone else's request
    await expect(withContext(db.app, asResident(neighbour), (c) => c.query("INSERT INTO request_status_history (tenant_id, request_id, to_status) VALUES ($1, $2, 'approved')", [community, id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("comments", () => {
  it("keep internal notes away from the resident and the community, and let residents write only resident-visible ones on their own request", async () => {
    const id = await newRequest();
    const post = (ctx: Parameters<typeof withContext>[1], visibility: string, body: string, author: string) =>
      withContext(db.app, ctx, (c) => c.query("INSERT INTO request_comments (tenant_id, request_id, author_id, visibility, body) VALUES ($1, $2, $3, $4, $5)", [community, id, author, visibility, body]));
    await post(asResident(), "resident", "We prefer mornings.", resident);
    await post(asOps(), "resident", "Thanks, noted.", ops);
    await post(asOps(), "internal", "Parent was rude on the phone; be brief.", ops);

    const visible = (ctx: Parameters<typeof withContext>[1]) => withContext(db.app, ctx, async (c) => (await c.query("SELECT body FROM request_comments WHERE request_id = $1 ORDER BY created_at", [id])).rows.map((r) => r.body as string));
    expect(await visible(asResident())).toEqual(["We prefer mornings.", "Thanks, noted."]);
    expect(await visible(asAdmin())).toEqual(["We prefer mornings.", "Thanks, noted."]);
    expect((await visible(asOps())).length).toBe(3);
    expect(await visible(asResident(neighbour))).toEqual([]);
    expect(await visible(asResident(stranger, otherCommunity))).toEqual([]);

    await expect(post(asResident(), "internal", "sneaky", resident)).rejects.toMatchObject({ code: "42501" }); // residents cannot write internal notes
    await expect(post(asResident(), "resident", "as the ops person", ops)).rejects.toMatchObject({ code: "42501" }); // cannot write as someone else
    await expect(post(asResident(neighbour), "resident", "on a neighbour's request", neighbour)).rejects.toMatchObject({ code: "42501" });
    await expect(post(asAdmin(), "resident", "administrators do not comment", admin)).rejects.toMatchObject({ code: "42501" });
    await expect(q("UPDATE request_comments SET body = 'edited'")).rejects.toThrow();
    await expect(q("DELETE FROM request_comments")).rejects.toThrow();
  });
});

describe("reference data", () => {
  it("the workflow, SLA targets and request types are readable by signed-in people and changeable by nobody through the application role", async () => {
    const counts = await withContext(db.app, { userId: resident }, async (c) => ({
      statuses: (await c.query("SELECT 1 FROM workflow_statuses")).rowCount,
      transitions: (await c.query("SELECT 1 FROM workflow_transitions")).rowCount,
      sla: (await c.query("SELECT 1 FROM sla_rules")).rowCount,
      types: (await c.query("SELECT 1 FROM request_types WHERE is_active")).rowCount,
    }));
    expect(counts).toEqual({ statuses: 18, transitions: 34, sla: 8, types: 3 });
    expect(await withContext(db.app, {}, async (c) => (await c.query("SELECT 1 FROM workflow_transitions")).rowCount)).toBe(0);
    for (const sql of ["INSERT INTO workflow_transitions VALUES ('submitted', 'approved', 'staff', 'requests.transition', false, 'x')", "UPDATE sla_rules SET hours = 1", "DELETE FROM workflow_statuses"]) {
      await expect(withContext(db.app, { userId: ops, platformScope: true }, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("every transition names a real permission, and the actors who can take a step match the people the catalog gives that permission to", async () => {
    const bad = await q(`SELECT t.from_status, t.to_status FROM workflow_transitions t WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = t.permission)`);
    expect(bad.rows).toEqual([]);
    const requesterSteps = await q(`SELECT t.permission, count(*)::int AS n FROM workflow_transitions t WHERE t.actor = 'requester' GROUP BY t.permission ORDER BY t.permission`);
    for (const r of requesterSteps.rows) {
      const holders = await q(`SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code = $1 AND r.scope_type IN ('community') ORDER BY r.key`, [r.permission]);
      expect(holders.rows.map((x) => x.key), r.permission).toContain("resident");
    }
  });
});
