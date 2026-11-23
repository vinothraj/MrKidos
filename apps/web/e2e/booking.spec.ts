import { expect, test, type Browser, type Page } from "@playwright/test";
import { alertBox, enrollMfaViaUi, expectNoAxeViolations, grantPlatformRole, registerViaUi, sql, uniqueEmail, verifyEmailInDb } from "./helpers";

/** A separate browser session (its own cookies) for one person in the story. */
async function newPerson(browser: Browser, email: string, name: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: "http://localhost:3010", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await registerViaUi(page, email, name);
  await verifyEmailInDb(email);
  return page;
}
async function selectOrganization(page: Page, name: string): Promise<void> {
  await page.getByLabel("Active organization").selectOption({ label: name });
  await expect(page.getByLabel("Active organization")).toHaveValue(/[0-9a-f-]{36}/);
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Account" });
const badge = (page: Page, text: string) => page.locator(".k-badge", { hasText: text }).first();
const localInput = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
};

test.describe.serial("booking: from a family's request to a completed booking", () => {
  const stamp = Date.now().toString(36);
  const communityName = `Booking Beach ${stamp}`;
  const vendorName = `Coach Chandra ${stamp}`;
  const title = `Cricket weekend ${stamp}`;
  const opsEmail = uniqueEmail("bops");
  const residentEmail = uniqueEmail("bres");
  const vendorEmail = uniqueEmail("bven");
  let ops: Page;
  let resident: Page;
  let vendor: Page;
  let requestUrl = "";
  let inquiryUrl = "";

  test.beforeAll(async ({ browser }) => {
    ops = await newPerson(browser, opsEmail, "Olivia Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops);
    resident = await newPerson(browser, residentEmail, "Rhea Resident");
    vendor = await newPerson(browser, vendorEmail, "Vik Vendor");
    await enrollMfaViaUi(vendor); // vendor owners require two-step verification; done before the role arrives

    // Arrangement only: an active community, an active, vetted and approved vendor serving it, and the people in each.
    const one = async <T extends { id: string }>(text: string, params: unknown[]): Promise<string> => {
      const row = (await sql<T>(text, params))[0];
      if (!row) throw new Error("fixture row missing");
      return row.id;
    };
    const community = await one("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [communityName]);
    const vendorId = await one("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'active') RETURNING id", [vendorName]);
    const user = async (email: string) => one("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    const residentId = await user(residentEmail);
    const vendorUser = await user(vendorEmail);
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community, residentId]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key IN ('resident', 'parent_guardian') AND tenant_id IS NULL", [community, residentId]);
    await sql("INSERT INTO vendor_profiles (tenant_id, description, city, years_experience) VALUES ($1, 'Cricket coaching for children.', 'Bengaluru', 8)", [vendorId]);
    await sql("INSERT INTO vendor_private (tenant_id) VALUES ($1)", [vendorId]);
    await sql("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [vendorId, community]);
    await sql("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [vendorId]);
    await sql("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [community, vendorId]);
    await sql("INSERT INTO vendor_categories (tenant_id, category_id) SELECT $1, id FROM categories WHERE key = 'cricket'", [vendorId]);
    await sql(
      "INSERT INTO offerings (tenant_id, category_id, name, description, pricing_model, price_minor, duration_minutes, cancellation_policy, status) SELECT $1, id, 'Weekend cricket camp', 'Fun', 'fixed', 500000, 120, 'Free up to 48h', 'published' FROM categories WHERE key = 'cricket'",
      [vendorId],
    );
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [vendorId, vendorUser]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'vendor_owner' AND tenant_id IS NULL", [vendorId, vendorUser]);
  });
  test.afterAll(async () => {
    for (const p of [ops, resident, vendor]) await p.context().close();
  });

  test("the family makes a request, and operations take it through review to finding vendors", async () => {
    await resident.goto("/app");
    await selectOrganization(resident, communityName);
    await resident.goto("/app/requests/new");
    const form = resident.getByRole("form", { name: "Make a request" });
    await form.getByLabel("Give it a short title").fill(title);
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("One time or regular?").selectOption("one_time");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Number of children").fill("12");
    await form.getByLabel("Youngest age").fill("8");
    await form.getByLabel("Oldest age").fill("12");
    await form.getByLabel("Budget in rupees").fill("8000");
    await form.getByLabel("Category").selectOption({ label: "Cricket" });
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(resident).toHaveURL(/\/app\/requests\/[0-9a-f-]{36}$/);
    requestUrl = new URL(resident.url()).pathname;

    await ops.goto("/app");
    await ops.getByRole("button", { name: "Platform mode" }).click();
    await ops.goto(requestUrl);
    await expect(ops.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await ops.getByRole("button", { name: "Start review" }).click();
    await expect(badge(ops, "Under review")).toBeVisible();
    await ops.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(badge(ops, "Approved")).toBeVisible();
    await ops.getByRole("button", { name: "Start finding vendors" }).click();
    await expect(badge(ops, "Finding options")).toBeVisible();
    await expect(ops.getByRole("heading", { name: "Vendors to ask" })).toBeVisible();
    await expect(ops.getByText("No vendors suggested yet")).toBeVisible();
  });

  test("matching explains every score, and operations ask the vendor without saying who asked", async () => {
    await ops.getByRole("button", { name: "Find matching vendors" }).click();
    const table = ops.getByRole("table", { name: "Suggested vendors" });
    const row = table.getByRole("row", { name: new RegExp(vendorName) });
    await expect(row).toContainText("Offers exactly this category");
    await expect(row).toContainText("Within the budget");
    await expect(row).toContainText("Handles this many children");
    await expect(row).toContainText("/ 100");

    await ops.getByLabel("Message for the vendors").fill("Two sessions on the Saturday, please.");
    await row.getByLabel(`Ask ${vendorName}`).check();
    await ops.getByRole("button", { name: "Ask 1 selected vendor" }).click();
    await expect(badge(ops, "Asking vendors")).toBeVisible();
    await expect(ops.getByRole("heading", { name: "Inquiries", exact: true })).toBeVisible();
    await expect(ops.getByText("Waiting for an answer")).toBeVisible();
    await expect(table.getByText("Asked")).toBeVisible();
  });

  test("the vendor sees what is needed but not who asked, and sends a quote", async () => {
    await vendor.goto("/app");
    await selectOrganization(vendor, vendorName);
    await nav(vendor).getByRole("link", { name: "Inquiries" }).click();
    await expect(vendor.getByRole("heading", { level: 1, name: "Inquiries" })).toBeVisible();
    const row = vendor.getByRole("row", { name: new RegExp(title) });
    await expect(row).toContainText("Needs your answer");
    await expect(row).toContainText(communityName);
    await row.getByRole("link", { name: title }).click();
    await expect(vendor).toHaveURL(/\/app\/inquiries\/[0-9a-f-]{36}$/); // navigation finished before the address is kept
    inquiryUrl = new URL(vendor.url()).pathname;

    await expect(vendor.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(vendor.getByText("Two sessions on the Saturday, please.")).toBeVisible();
    await expect(vendor.getByText("12", { exact: true })).toBeVisible();
    await expect(vendor.getByText("Rhea Resident")).toHaveCount(0); // never who asked
    await expect(vendor.getByText(residentEmail)).toHaveCount(0);

    const form = vendor.getByRole("form", { name: "Send your quote" });
    await expect(form.getByRole("button", { name: "Send your quote" })).toBeDisabled(); // an empty quote cannot be sent
    await form.getByLabel("Item 1").fill("Coaching for 12 children, two sessions");
    await form.getByLabel("Quantity 1").fill("2");
    await form.getByLabel("Price each in rupees 1").fill("2500");
    await form.getByRole("button", { name: "Add another item" }).click();
    await form.getByLabel("Item 2").fill("Equipment");
    await form.getByLabel("Price each in rupees 2").fill("500");
    await expect(form.getByText("Total ₹5,500")).toBeVisible();
    await form.getByRole("button", { name: "Send your quote" }).click();
    await expect(badge(vendor, "You quoted")).toBeVisible();
    await expect(vendor.getByText("Total ₹5,500").first()).toBeVisible();
    await expect(vendor.getByText("Sent to the team")).toBeVisible();
  });

  test("operations compare the quote, shortlist it and offer it to the family", async () => {
    await ops.reload();
    await ops.getByRole("button", { name: "Quotes are in" }).click();
    await expect(badge(ops, "Quotes received")).toBeVisible();
    const quotes = ops.getByRole("table", { name: "Quotes" });
    await expect(quotes.getByText("Total ₹5,500")).toBeVisible();
    // offering nothing is refused with a reason
    await ops.getByRole("button", { name: "Offer these options to the family" }).click();
    await expect(alertBox(ops)).toContainText("Shortlist at least one quote");
    await quotes.getByRole("button", { name: /^Shortlist/ }).click();
    await expect(quotes.getByText("Offered to the family")).toBeVisible();
    // shortlisting is the team's working step: the family sees nothing until the options are actually offered
    await resident.goto(requestUrl);
    await expect(resident.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(resident.getByRole("heading", { name: "Your options" })).toHaveCount(0);
    await ops.getByRole("button", { name: "Offer these options to the family" }).click();
    await expect(badge(ops, "Shortlisted")).toBeVisible();
  });

  test("the family sees the option, chooses it after a confirmation, and a booking opens", async () => {
    await resident.goto(requestUrl);
    await expect(resident.getByText("Your options are ready")).toBeVisible();
    const options = resident.locator("section, div").filter({ has: resident.getByRole("heading", { name: "Your options" }) }).last();
    await expect(options.getByRole("heading", { name: vendorName })).toBeVisible();
    await expect(options.getByText("Total ₹5,500")).toBeVisible();
    await expect(resident.getByRole("button", { name: "Accept this quote" })).toHaveCount(0); // choosing has its own button
    await resident.getByRole("button", { name: /^Choose this option/ }).click();
    await expect(resident.getByText(/Choose .* for ₹5,500\?/)).toBeVisible();
    await resident.getByRole("button", { name: "Not yet" }).click();
    await expect(badge(resident, "Shortlisted")).toBeVisible();
    await resident.getByRole("button", { name: /^Choose this option/ }).click();
    await resident.getByRole("button", { name: "Yes, choose this option" }).click();

    await expect(badge(resident, "Booking pending")).toBeVisible();
    await expect(resident.getByRole("heading", { name: "Your booking" })).toBeVisible();
    await expect(resident.getByText("Waiting for the vendor")).toBeVisible();
    await expect(resident.getByText("You pay the vendor directly.")).toBeVisible();
  });

  test("operations set the date, the vendor confirms it, operations confirm the booking", async () => {
    await ops.reload();
    await expect(badge(ops, "Booking pending")).toBeVisible();
    await expect(ops.getByText("Set the date and place, then the vendor can confirm.")).toBeVisible();
    const schedule = ops.getByRole("form", { name: "Set the date and place" });
    await schedule.getByLabel("Starts").fill(localInput(5, 10));
    await schedule.getByLabel("Ends").fill(localInput(5, 12));
    await schedule.getByLabel("Where").fill("Community clubhouse");
    await schedule.getByRole("button", { name: "Save date and place" }).click();
    await expect(ops.getByText("Waiting for the vendor to confirm this date.")).toBeVisible();
    // operations cannot confirm before the vendor has
    await ops.getByRole("button", { name: "Confirm the booking" }).click();
    await expect(alertBox(ops)).toContainText("The vendor has not confirmed the booking yet");

    await vendor.goto(inquiryUrl);
    await expect(vendor.getByText("Chosen by the family").first()).toBeVisible();
    await expect(vendor.getByText("Community clubhouse")).toBeVisible();
    await vendor.getByRole("button", { name: "Confirm this date" }).click();
    await expect(vendor.getByText("You confirmed this date. The team will confirm the booking.")).toBeVisible();

    await ops.reload();
    await expect(ops.getByText(/The vendor confirmed on/)).toBeVisible();
    await ops.getByRole("button", { name: "Confirm the booking" }).click();
    await expect(badge(ops, "Confirmed")).toBeVisible();

    await resident.reload();
    await expect(badge(resident, "Confirmed")).toBeVisible();
    await expect(resident.getByText("Community clubhouse")).toBeVisible();
  });

  test("the booking is completed, and the family and vendor see it finished", async () => {
    await ops.getByRole("button", { name: "Mark as completed" }).click();
    await expect(badge(ops, "Completed")).toBeVisible();
    await resident.reload();
    await expect(badge(resident, "Completed")).toBeVisible();
    await expect(resident.getByRole("button", { name: "Cancel my request" })).toHaveCount(0);
    await vendor.reload();
    await expect(vendor.getByText("Completed", { exact: true }).first()).toBeVisible();
  });

  test("operations set the platform fee and record what was paid offline; the family sees what they paid but not the fee", async () => {
    await ops.reload();
    const fee = ops.getByRole("form", { name: "Platform fee" });
    await fee.getByLabel("Platform fee in rupees").fill("550");
    await fee.getByRole("button", { name: "Save the fee" }).click();
    await expect(ops.getByText("Platform fee ₹550; paid ₹0.")).toBeVisible();

    const pay = ops.getByRole("form", { name: "Record a payment" });
    await pay.getByLabel("Amount in rupees").fill("9000"); // more than the agreed price
    await pay.getByRole("button", { name: "Record the payment" }).click();
    await expect(alertBox(ops)).toContainText("more than the agreed price");
    await pay.getByLabel("Amount in rupees").fill("2000");
    await pay.getByLabel("Reference (optional)").fill("UPI-77");
    await pay.getByRole("button", { name: "Record the payment" }).click();
    await expect(ops.getByText("Part paid", { exact: true })).toBeVisible();
    await expect(ops.getByText("₹2,000 of ₹5,500")).toBeVisible();
    await pay.getByLabel("Amount in rupees").fill("3500");
    await pay.getByRole("button", { name: "Record the payment" }).click();
    await expect(ops.getByText("Paid in full")).toBeVisible();
    await pay.getByLabel("Who paid whom").selectOption("vendor_to_platform");
    await pay.getByLabel("Amount in rupees").fill("550");
    await pay.getByRole("button", { name: "Record the payment" }).click();
    await expect(ops.getByText("Platform fee ₹550; paid ₹550.")).toBeVisible();

    await resident.reload();
    await expect(resident.getByText("Paid in full")).toBeVisible();
    await expect(resident.getByText("UPI-77")).toBeVisible();
    await expect(resident.getByText("Platform fee")).toHaveCount(0); // the vendor's fee is not the family's business
    await vendor.goto(inquiryUrl);
    await expect(vendor.getByText("Platform fee ₹550; paid ₹550.")).toBeVisible();
  });

  test("the family is reminded to review, reviews, and the review waits to be checked", async () => {
    await resident.goto("/app");
    const waiting = resident.getByRole("region", { name: "Waiting for you" }).or(resident.getByRole("heading", { name: "Waiting for you" }));
    await expect(waiting.first()).toBeVisible();
    await expect(resident.getByRole("link", { name: new RegExp(`Tell us how it went: ${title}`) })).toBeVisible();
    await resident.getByRole("link", { name: new RegExp("Tell us how it went") }).click();

    const form = resident.getByRole("form", { name: "Leave a review" });
    await expect(form.getByRole("button", { name: "Send my review" })).toBeDisabled(); // a rating is needed
    await form.getByLabel("How was it?").selectOption("5");
    await form.getByLabel("Tell other families").fill("Brilliant weekend, the children loved it.");
    await form.getByRole("button", { name: "Send my review" }).click();
    await expect(resident.getByText("Waiting to be checked")).toBeVisible();
    await expect(resident.getByText("The team checks every review before anyone else can read it.")).toBeVisible();
    await expect(resident.getByRole("form", { name: "Leave a review" })).toHaveCount(0); // once only

    // not visible to anyone else yet
    const vendorId = (await sql<{ id: string }>("SELECT id FROM organizations WHERE name = $1", [vendorName]))[0]?.id ?? "";
    await resident.goto(`/app/catalog/vendors/${vendorId}`);
    await expect(resident.getByText("No reviews yet.")).toBeVisible();
  });

  test("operations publish it, the vendor replies once, and the vendor page shows both without a name", async () => {
    await ops.goto("/app");
    await nav(ops).getByRole("link", { name: "Reviews" }).click();
    await expect(ops.getByRole("heading", { level: 1, name: "Reviews" })).toBeVisible();
    const row = ops.locator("li", { hasText: vendorName });
    await expect(row).toContainText("Brilliant weekend");
    await expect(row).toContainText("5 out of 5");
    await row.getByRole("button", { name: /^Do not publish/ }).click();
    await expect(alertBox(ops)).toContainText("Say why this review is not published");
    await row.getByRole("button", { name: /^Publish/ }).click();
    await expect(ops.getByText("Nothing here")).toBeVisible();

    await vendor.goto("/app");
    await nav(vendor).getByRole("link", { name: "Reviews" }).click();
    const reply = vendor.getByRole("form", { name: /^Reply to the 5 out of 5 review/ });
    await reply.getByLabel("Your reply").fill("Thank you, it was a pleasure!");
    await reply.getByRole("button", { name: "Send reply" }).click();
    await expect(vendor.getByText("Your reply:")).toBeVisible();
    await expect(vendor.getByRole("form", { name: /^Reply to/ })).toHaveCount(0); // once only

    const vendorId = (await sql<{ id: string }>("SELECT id FROM organizations WHERE name = $1", [vendorName]))[0]?.id ?? "";
    await resident.goto(`/app/catalog/vendors/${vendorId}`);
    await expect(resident.getByRole("heading", { name: "What families say" })).toBeVisible();
    await expect(resident.getByText("5 out of 5 from 1 review")).toBeVisible();
    await expect(resident.getByText("Brilliant weekend, the children loved it.")).toBeVisible();
    await expect(resident.getByText("Thank you, it was a pleasure!")).toBeVisible();
    await expect(resident.getByText("Rhea Resident")).toHaveCount(0); // anonymous

    // the reminders are gone
    await resident.goto("/app");
    await expect(resident.getByRole("link", { name: /Tell us how it went/ })).toHaveCount(0);
  });

  test("every new screen passes the accessibility scan in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const p of [ops, resident, vendor]) await p.emulateMedia({ colorScheme: scheme });
      await ops.goto(requestUrl);
      await expect(ops.getByRole("table", { name: "Suggested vendors" })).toBeVisible();
      await expect(ops.getByRole("table", { name: "Quotes" })).toBeVisible();
      await expectNoAxeViolations(ops, `request with the sourcing workspace (${scheme})`);
      await resident.goto(requestUrl);
      await expect(resident.getByRole("heading", { name: "Your booking" })).toBeVisible();
      await expectNoAxeViolations(resident, `request with a booking as a family (${scheme})`);
      await vendor.goto("/app/inquiries");
      await expect(vendor.getByRole("table", { name: "Inquiries" })).toBeVisible();
      await expectNoAxeViolations(vendor, `vendor inquiries (${scheme})`);
      await vendor.goto(inquiryUrl);
      await expect(vendor.getByRole("heading", { name: "Booking", exact: true })).toBeVisible();
      await expectNoAxeViolations(vendor, `vendor inquiry (${scheme})`);
      await vendor.goto("/app/reviews");
      await expect(vendor.getByText("Your reply:")).toBeVisible();
      await expectNoAxeViolations(vendor, `vendor reviews (${scheme})`);
      await ops.goto("/app/reviews");
      await expect(ops.getByRole("heading", { level: 1, name: "Reviews" })).toBeVisible();
      await expectNoAxeViolations(ops, `review moderation (${scheme})`);
      const vendorId = (await sql<{ id: string }>("SELECT id FROM organizations WHERE name = $1", [vendorName]))[0]?.id ?? "";
      await resident.goto(`/app/catalog/vendors/${vendorId}`);
      await expect(resident.getByRole("heading", { name: "What families say" })).toBeVisible();
      await expectNoAxeViolations(resident, `vendor page with reviews (${scheme})`);
      await ops.goto(requestUrl);
      await expect(ops.getByRole("form", { name: "Record a payment" })).toBeVisible();
      await expectNoAxeViolations(ops, `payments editor (${scheme})`);
    }
  });
});

test.describe("sourcing screens are closed to the wrong people", () => {
  test("a family cannot reach the vendor inbox or the team's sourcing view", async ({ page }) => {
    const email = uniqueEmail("bnosy");
    await registerViaUi(page, email, "Nosy Family");
    await verifyEmailInDb(email);
    await page.goto("/app/inquiries");
    await expect(page.getByText("This is the vendor's inbox")).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Inquiries" })).toHaveCount(0);
    const res = await page.request.get("/api/v1/requests/00000000-0000-4000-8000-0000000000aa/sourcing");
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
