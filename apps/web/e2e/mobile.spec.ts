import { expect, test } from "@playwright/test";
import { enrollMfaViaUi, expectNoAxeViolations, registerViaUi, sql, uniqueEmail, verifyEmailInDb, PASSWORD_LABEL } from "./helpers";

test.describe("phone layout (390 x 844)", () => {
  test("public pages never scroll sideways", async ({ page }) => {
    for (const path of ["/", "/login", "/register", "/forgot-password"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
  });

  test("primary controls meet the 44px touch target size", async ({ page }) => {
    await page.goto("/login");
    for (const control of [page.getByLabel("Email"), page.getByLabel(PASSWORD_LABEL), page.getByRole("button", { name: "Sign in" })]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("the signed-in menu collapses behind a button and works by touch", async ({ page }) => {
    await registerViaUi(page, uniqueEmail("phone"));
    const menu = page.getByRole("button", { name: "Menu" });
    const nav = page.getByRole("navigation", { name: "Account" });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(nav).toBeHidden();

    await menu.tap();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: "Security" })).toBeVisible();
    await nav.getByRole("link", { name: "Security" }).tap();
    await expect(page).toHaveURL(/\/app\/security$/);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, "security on phone");
  });

  test("the resident screens for joining a community and the family fit a phone and stay accessible", async ({ page }) => {
    const email = uniqueEmail("phoneres");
    await registerViaUi(page, email);
    await verifyEmailInDb(email);
    for (const path of ["/app/join", "/app/family"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
      await expectNoAxeViolations(page, `${path} on phone`);
    }
    // the primary action in each form is reachable and large enough to tap
    await page.goto("/app/join");
    const box = await page.getByRole("button", { name: "Join community" }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await page.goto("/app/family");
    const add = await page.getByRole("button", { name: "Add child" }).boundingBox();
    expect(add?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test("the vendor workspace and the catalog fit a phone and stay accessible", async ({ page }) => {
    const email = uniqueEmail("phonevendor");
    await registerViaUi(page, email);
    await verifyEmailInDb(email);
    await enrollMfaViaUi(page); // vendor owners require two-step verification; enrolled before the role arrives
    // Arrangement only: an active vendor whose owner is this person (the real onboarding has its own journey).
    const user = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]))[0];
    const vendor = (await sql<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'active') RETURNING id", [`Phone Vendor ${Date.now().toString(36)}`]))[0];
    if (!user || !vendor) throw new Error("fixture rows not created");
    await sql("INSERT INTO vendor_profiles (tenant_id, business_type, description, city) VALUES ($1, 'individual', 'Coaching for children.', 'Bengaluru')", [vendor.id]);
    await sql("INSERT INTO vendor_private (tenant_id) VALUES ($1)", [vendor.id]);
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [vendor.id, user.id]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendor.id, user.id]);
    const switched = await page.request.post("/api/v1/me/tenants/switch", { data: { tenantId: vendor.id }, headers: { origin: "http://localhost:3010" } });
    expect(switched.ok()).toBe(true);

    await page.goto(`/app/vendors/${vendor.id}`);
    await expect(page.getByRole("heading", { level: 1, name: /Phone Vendor/ })).toBeVisible();
    await expect(page.locator("#availability").getByRole("form", { name: "Weekly hours" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow on the vendor workspace").toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, "vendor workspace on phone");
    const save = await page.getByRole("button", { name: "Save weekly hours" }).boundingBox();
    expect(save?.height ?? 0).toBeGreaterThanOrEqual(43.5);

    // a resident without a community is told what to do, in a layout that fits
    const resident = uniqueEmail("phonecat");
    await page.request.post("/api/v1/auth/logout", { headers: { origin: "http://localhost:3010" } });
    await registerViaUi(page, resident);
    await verifyEmailInDb(resident);
    await page.goto("/app/catalog");
    await expect(page.getByText("Choose a community")).toBeVisible();
    const catalogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(catalogOverflow, "horizontal overflow on the catalog").toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, "catalog on phone");
  });

  test("the request screens fit a phone, stay accessible, and keep the primary actions tappable", async ({ page }) => {
    const email = uniqueEmail("phonereq");
    await registerViaUi(page, email);
    await verifyEmailInDb(email);
    // Arrangement only: an active community this person belongs to, with one request already made.
    const user = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]))[0];
    const community = (await sql<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [`Phone Heights ${Date.now().toString(36)}`]))[0];
    if (!user || !community) throw new Error("fixture rows not created");
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community.id, user.id]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key IN ('resident', 'parent_guardian') AND tenant_id IS NULL", [community.id, user.id]);
    const request = (
      await sql<{ id: string }>(
        "INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, description, answers) VALUES ($1, $2, (SELECT id FROM request_types WHERE key = 'activity'), 1, 'Pottery morning on a phone', 'Hands-on clay session.', '{\"format\":\"one_time\"}') RETURNING id",
        [community.id, user.id],
      )
    )[0];
    if (!request) throw new Error("request not created");
    const switched = await page.request.post("/api/v1/me/tenants/switch", { data: { tenantId: community.id }, headers: { origin: "http://localhost:3010" } });
    expect(switched.ok()).toBe(true);

    for (const [path, ready] of [
      ["/app/requests", page.getByRole("table", { name: "Requests" })],
      ["/app/requests/new", page.getByRole("form", { name: "Make a request" })],
      [`/app/requests/${request.id}`, page.getByRole("heading", { level: 1, name: "Pottery morning on a phone" })],
    ] as const) {
      await page.goto(path);
      await expect(ready).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
      await expectNoAxeViolations(page, `${path} on phone`);
    }
    await page.goto("/app/requests/new");
    const form = page.getByRole("form", { name: "Make a request" });
    await form.getByLabel("Give it a short title").fill("Tappable check");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("One time or regular?").selectOption("one_time");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Next" }).click();
    await expectNoAxeViolations(page, "request review step on phone");
    const send = await page.getByRole("button", { name: "Send request" }).boundingBox();
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await page.goto(`/app/requests/${request.id}`);
    const cancel = await page.getByRole("button", { name: "Cancel my request" }).boundingBox();
    expect(cancel?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test("a family's options and a vendor's quote form fit a phone, stay accessible, and keep the primary actions tappable", async ({ page }) => {
    const email = uniqueEmail("phonesrc");
    await registerViaUi(page, email);
    await verifyEmailInDb(email);
    await enrollMfaViaUi(page); // a vendor owner requires two-step verification; enrolled before the role arrives
    // Arrangement only: this person is a family in a community AND the owner of a vendor that was asked to quote.
    const one = async (text: string, params: unknown[]): Promise<string> => {
      const row = (await sql<{ id: string }>(text, params))[0];
      if (!row) throw new Error("fixture row missing");
      return row.id;
    };
    const stamp = Date.now().toString(36);
    const userId = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    const community = await one("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [`Phone Shore ${stamp}`]);
    const vendor = await one("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'active') RETURNING id", [`Phone Coach ${stamp}`]);
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $3), ($2, $3)", [community, vendor, userId]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key IN ('resident', 'parent_guardian') AND tenant_id IS NULL", [community, userId]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendor, userId]);
    const typeId = await one("SELECT id FROM request_types WHERE key = 'activity'", []);
    const mkRequest = (name: string, status: string) =>
      one("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, $3, 1, $4, $5) RETURNING id", [community, userId, typeId, name, status]);
    const offered = await mkRequest("Offered on a phone", "shortlisted");
    const asked = await mkRequest("Asked on a phone", "vendor_inquiry");
    const inquiry = (request: string, status: string) =>
      one("INSERT INTO inquiries (tenant_id, request_id, vendor_id, status, snapshot) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id", [community, request, vendor, status, JSON.stringify({ title: "Asked on a phone", description: "A morning session.", participantCount: 10, community: { name: "Phone Shore" }, answers: [] })]);
    const quotedInquiry = await inquiry(offered, "quoted");
    const openInquiry = await inquiry(asked, "sent");
    const quote = await one("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'shortlisted', 450000) RETURNING id", [community, offered, quotedInquiry, vendor]);
    await sql("INSERT INTO quote_line_items (tenant_id, quote_id, description, quantity, unit_minor) VALUES ($1, $2, 'The session', 1, 450000)", [community, quote]);

    const switchTo = async (tenantId: string) => {
      const res = await page.request.post("/api/v1/me/tenants/switch", { data: { tenantId }, headers: { origin: "http://localhost:3010" } });
      expect(res.ok()).toBe(true);
    };
    const check = async (path: string, ready: ReturnType<typeof page.getByRole>) => {
      await page.goto(path);
      await expect(ready).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
      await expectNoAxeViolations(page, `${path} on phone`);
    };

    await switchTo(community);
    await check(`/app/requests/${offered}`, page.getByRole("heading", { name: "Your options" }));
    const choose = await page.getByRole("button", { name: /^Choose this option/ }).boundingBox();
    expect(choose?.height ?? 0).toBeGreaterThanOrEqual(43.5);

    await switchTo(vendor);
    await check("/app/inquiries", page.getByRole("table", { name: "Inquiries" }));
    await check(`/app/inquiries/${openInquiry}`, page.getByRole("form", { name: "Send your quote" }));
    const send = await page.getByRole("button", { name: "Send your quote" }).boundingBox();
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test("a completed booking's payment summary and review form fit a phone and stay accessible", async ({ page }) => {
    const email = uniqueEmail("phonerev");
    await registerViaUi(page, email);
    await verifyEmailInDb(email);
    const one = async (text: string, params: unknown[]): Promise<string> => {
      const row = (await sql<{ id: string }>(text, params))[0];
      if (!row) throw new Error("fixture row missing");
      return row.id;
    };
    const stamp = Date.now().toString(36);
    const userId = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    const community = await one("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [`Phone Reef ${stamp}`]);
    const vendor = await one("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'active') RETURNING id", [`Phone Reefer ${stamp}`]);
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, userId]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key IN ('resident', 'parent_guardian') AND tenant_id IS NULL", [community, userId]);
    const typeId = await one("SELECT id FROM request_types WHERE key = 'activity'", []);
    const request = await one("INSERT INTO requests (tenant_id, requester_id, request_type_id, schema_version, title, status) VALUES ($1, $2, $3, 1, 'Finished on a phone', 'completed') RETURNING id", [community, userId, typeId]);
    const inquiry = await one("INSERT INTO inquiries (tenant_id, request_id, vendor_id, status, snapshot) VALUES ($1, $2, $3, 'quoted', '{}'::jsonb) RETURNING id", [community, request, vendor]);
    const quote = await one("INSERT INTO quotes (tenant_id, request_id, inquiry_id, vendor_id, status, total_minor) VALUES ($1, $2, $3, $4, 'accepted', 300000) RETURNING id", [community, request, inquiry, vendor]);
    const booking = await one("INSERT INTO bookings (tenant_id, request_id, quote_id, vendor_id, status, agreed_total_minor, scheduled_start, vendor_confirmed_at, confirmed_at, completed_at) VALUES ($1, $2, $3, $4, 'completed', 300000, now() - interval '1 day', now(), now(), now()) RETURNING id", [community, request, quote, vendor]);
    await sql("INSERT INTO booking_payments (tenant_id, booking_id, kind, amount_minor, method, paid_on) VALUES ($1, $2, 'family_to_vendor', 100000, 'upi', current_date)", [community, booking]);
    const switched = await page.request.post("/api/v1/me/tenants/switch", { data: { tenantId: community }, headers: { origin: "http://localhost:3010" } });
    expect(switched.ok()).toBe(true);

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
    await expectNoAxeViolations(page, "dashboard with things waiting on phone");
    await page.goto(`/app/requests/${request}`);
    await expect(page.getByRole("form", { name: "Leave a review" })).toBeVisible();
    await expect(page.getByText("Part paid", { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow on the booking").toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, "booking with payments and a review form on phone");
    const send = await page.getByRole("button", { name: "Send my review" }).boundingBox();
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test("text stays readable when the user zooms to 200%", async ({ page }) => {
    await page.goto("/register");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
