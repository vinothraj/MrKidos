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

test.describe.serial("vendors: onboarding, vetting, approval by a community, and what residents see", () => {
  const stamp = Date.now().toString(36);
  const communityName = `Vendor Vale ${stamp}`;
  const vendorName = `Asha Sports ${stamp}`;
  const opsEmail = uniqueEmail("vops");
  const adminEmail = uniqueEmail("vadmin");
  const ownerEmail = uniqueEmail("vowner");
  const residentEmail = uniqueEmail("vres");
  let ops: Page;
  let admin: Page;
  let owner: Page;
  let resident: Page;
  let vendorUrl = "";
  let communityId = "";

  test.beforeAll(async ({ browser }) => {
    ops = await newPerson(browser, opsEmail, "Olivia Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops);
    admin = await newPerson(browser, adminEmail, "Asha Admin");
    await enrollMfaViaUi(admin);
    owner = await newPerson(browser, ownerEmail, "Omar Owner");
    await enrollMfaViaUi(owner); // vendor owners require two-step verification; done before the role arrives
    resident = await newPerson(browser, residentEmail, "Rhea Resident");

    // An active community with an administrator, set up through the real screens.
    await ops.goto("/app");
    await ops.getByRole("button", { name: "Platform mode" }).click();
    await ops.goto("/app/communities/new");
    const form = ops.getByRole("form", { name: "Register a community" });
    await form.getByLabel("Community name").fill(communityName);
    await form.getByLabel("Number of homes (units)").fill("200");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("State").fill("Karnataka");
    await form.getByLabel("City").fill("Bengaluru");
    await form.getByLabel("Locality or area").fill("Whitefield");
    await form.getByLabel("Street address").fill("3 Vale Road");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Contact person").fill("Ramesh");
    await form.getByLabel("Contact email").fill("ramesh@example.test");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Register community" }).click();
    await expect(ops).toHaveURL(/\/app\/communities\/[0-9a-f-]{36}$/);
    const status = ops.locator("#status");
    await status.getByRole("button", { name: "Submit for verification" }).click();
    await expect(status.getByText("Assign at least one community administrator.")).toBeVisible();
    await ops.locator("#administrators").getByLabel("Add an administrator by email").fill(adminEmail);
    await ops.locator("#administrators").getByRole("button", { name: "Add administrator" }).click();
    await expect(ops.locator("#administrators").getByText(adminEmail)).toBeVisible();
    await status.getByLabel("Note").fill("Checked.");
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();

    // The resident is a member of that community (joining has its own journey in the communities spec).
    const communityRow = (await sql<{ id: string }>("SELECT id FROM organizations WHERE name = $1", [communityName]))[0];
    const userRow = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [residentEmail]))[0];
    if (!communityRow || !userRow) throw new Error("fixture rows not found");
    communityId = communityRow.id;
    const userId = userRow.id;
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [communityId, userId]);
    await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key IN ('resident', 'parent_guardian') AND tenant_id IS NULL", [communityId, userId]);
  });
  test.afterAll(async () => {
    for (const p of [ops, admin, owner, resident]) await p.context().close();
  });

  test("platform staff register a vendor and are told exactly what is missing", async () => {
    await ops.goto("/app");
    await nav(ops).getByRole("link", { name: "Vendors" }).click();
    await expect(ops.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible();
    await ops.getByRole("link", { name: "Register a vendor" }).click();
    const form = ops.getByRole("form", { name: "Register a vendor" });
    // Step 1 refuses to continue without the one required answer, and says what to do.
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("Enter the business name.")).toBeVisible();
    await form.getByLabel("Business name").fill(vendorName);
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("State").fill("Karnataka");
    await form.getByLabel("City").fill("Bengaluru");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Contact person").fill("Asha Coach");
    await form.getByLabel("Contact email").fill("asha@example.test");
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("Step 4 of 4")).toBeVisible();
    await form.getByRole("button", { name: "Register vendor" }).click();
    await expect(ops).toHaveURL(/\/app\/vendors\/[0-9a-f-]{36}$/);
    vendorUrl = new URL(ops.url()).pathname;
    await expect(ops.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();

    const status = ops.locator("#status");
    await expect(status.getByText("Before you can submit for verification")).toBeVisible();
    await expect(status.getByText("Add a description of what the vendor offers.")).toBeVisible();
    await expect(status.getByText("Choose at least one category.")).toBeVisible();
    await expect(status.getByText("Add at least one place the vendor serves (a community or a city).")).toBeVisible();
    await expect(status.getByRole("button", { name: "Submit for verification" })).toBeDisabled();
  });

  test("completing the profile, categories and places clears the checklist, then it goes to verification", async () => {
    const status = ops.locator("#status");
    const details = ops.getByRole("form", { name: "Business details" });
    await details.getByLabel("About the business").fill("Cricket and football coaching for children aged 6 to 12.");
    await details.getByLabel("Legal name").fill("Asha Sports LLP");
    await details.getByRole("button", { name: "Save details" }).click();
    await expect(ops.getByText("Details saved.")).toBeVisible();
    await expect(status.getByText("Add a description of what the vendor offers.")).toHaveCount(0);

    const categories = ops.getByRole("form", { name: "Categories" });
    await categories.getByLabel("Cricket").check();
    await categories.getByRole("button", { name: "Save categories" }).click();
    await expect(categories.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(status.getByText("Choose at least one category.")).toHaveCount(0);

    const place = ops.getByRole("form", { name: "Add a place you serve" });
    await place.getByLabel("Community", { exact: true }).selectOption(communityId);
    await place.getByRole("button", { name: "Add place" }).click();
    // (the name also appears in a screen-reader-only label and in the select's options, so match the visible list entry)
    await expect(ops.locator("#places").locator("strong", { hasText: communityName })).toBeVisible();

    await expect(status.getByRole("button", { name: "Submit for verification" })).toBeEnabled();
    await status.getByRole("button", { name: "Submit for verification" }).click();
    await expect(status.getByText("In verification", { exact: true }).first()).toBeVisible();
    // activation is blocked until every required document is verified
    await expect(status.getByText("Verify a current document for: Identity proof.")).toBeVisible();
    await expect(status.getByRole("button", { name: "Approve and activate" })).toBeDisabled();
  });

  test("the vendor's own person is added, submits documents, and cannot review them", async () => {
    await ops.locator("#team").getByLabel("Email of the person to add").fill(ownerEmail);
    await ops.locator("#team").getByLabel("Role").selectOption("vendor_owner");
    await ops.locator("#team").getByRole("button", { name: "Add to team" }).click();
    await expect(ops.locator("#team").getByText(ownerEmail)).toBeVisible();

    await owner.goto("/app");
    await selectOrganization(owner, vendorName);
    await nav(owner).getByRole("link", { name: "My business" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
    await expect(nav(owner).getByRole("link", { name: "Vendors", exact: true })).toHaveCount(0); // the platform list is not theirs
    await expect(owner.locator("#details").getByLabel("Platform team notes")).toHaveCount(0);

    const docs = owner.locator("#documents");
    for (const [type, title] of [
      ["Identity proof (required)", "Driving licence"],
      ["Background check (required)", "Police verification"],
      ["Child safety briefing (required)", "Safety briefing certificate"],
    ] as const) {
      const form = docs.getByRole("form", { name: "Submit a document" });
      await form.getByLabel("Document type").selectOption({ label: type });
      await form.getByLabel("Title").fill(title);
      await form.getByLabel("Reference or link").fill("secure-link-1");
      await form.getByRole("button", { name: "Submit document" }).click();
      await expect(docs.locator("strong", { hasText: title })).toBeVisible();
    }
    await expect(docs.getByRole("button", { name: /^Verify/ })).toHaveCount(0); // vendors cannot decide on their own documents
    await expect(docs.getByRole("button", { name: "Withdraw Driving licence" })).toBeVisible();
    await expect(owner.locator("#status").getByRole("button", { name: "Approve and activate" })).toHaveCount(0);
  });

  test("the platform team verifies each document, then approves; a rejected document needs a reason", async () => {
    await ops.goto(vendorUrl);
    const docs = ops.locator("#documents");
    await expect(docs.locator("strong", { hasText: "Driving licence" })).toBeVisible();

    await docs.getByRole("button", { name: "Do not accept Driving licence" }).click();
    await expect(alertBox(ops)).toContainText("Say why");
    await docs.getByLabel("Note for Driving licence").fill("The photo is unreadable.");
    await docs.getByRole("button", { name: "Do not accept Driving licence" }).click();
    await expect(docs.getByText("Reviewer note: The photo is unreadable.")).toBeVisible();

    // the vendor resubmits a clear copy
    await owner.reload();
    const ownerDocs = owner.locator("#documents");
    const form = ownerDocs.getByRole("form", { name: "Submit a document" });
    await form.getByLabel("Document type").selectOption({ label: "Identity proof (required)" });
    await form.getByLabel("Title").fill("Passport");
    await form.getByRole("button", { name: "Submit document" }).click();
    await expect(ownerDocs.locator("strong", { hasText: "Passport" })).toBeVisible();

    await ops.reload();
    for (const title of ["Passport", "Police verification", "Safety briefing certificate"]) {
      await ops.locator("#documents").getByRole("button", { name: `Verify ${title}` }).click();
      await expect(ops.locator("#documents").getByRole("button", { name: `Verify ${title}` })).toHaveCount(0);
    }
    await expect(ops.locator("#documents").getByText("Every required document is verified.")).toBeVisible();

    await ops.reload();
    const status = ops.locator("#status");
    await expect(status.getByRole("button", { name: "Approve and activate" })).toBeEnabled();
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(alertBox(ops)).toContainText("Add a note");
    await status.getByLabel("Note").fill("All documents verified.");
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();
    await expect(status.getByText("All documents verified.")).toBeVisible();
  });

  test("the vendor publishes an offering once it is complete, and sets weekly hours", async () => {
    await owner.reload();
    const offerings = owner.locator("#offerings");
    const form = offerings.getByRole("form", { name: "Add an offering" });
    await form.getByLabel("Name").fill("Weekend cricket camp");
    await form.getByLabel("Category").selectOption({ label: "Cricket" });
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Price (₹)").fill("500");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Youngest age").fill("6");
    await form.getByLabel("Oldest age").fill("12");
    await form.getByLabel("Fewest children").fill("10");
    await form.getByLabel("Most children").fill("4"); // wrong on purpose
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("The maximum cannot be less than the minimum.")).toBeVisible();

    await form.getByLabel("Most children").fill("20");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("10 to 20 children")).toBeVisible(); // the review shows what will be saved
    await form.getByRole("button", { name: "Add offering" }).click();
    const row = offerings.locator("li", { hasText: "Weekend cricket camp" }).first();
    await expect(row.getByText("Draft", { exact: true })).toBeVisible();
    // an incomplete draft says what it needs, and cannot be published
    await expect(row.getByText("Before you can publish Weekend cricket camp")).toBeVisible();
    await expect(row.getByRole("button", { name: "Publish Weekend cricket camp" })).toBeDisabled();

    await row.getByRole("button", { name: "Edit Weekend cricket camp" }).click();
    const edit = offerings.getByRole("form", { name: "Edit Weekend cricket camp" });
    await edit.getByLabel("Description").fill("Two hours of coaching for beginners, with nets and match play.");
    await edit.getByLabel("Duration (minutes)").fill("120");
    await edit.getByLabel("Cancellation policy").fill("Free cancellation up to 48 hours before.");
    await edit.getByRole("button", { name: "Save offering" }).click();
    const updated = offerings.locator("li", { hasText: "Weekend cricket camp" }).first();
    await updated.getByRole("button", { name: "Publish Weekend cricket camp" }).click();
    await expect(updated.getByText("Published", { exact: true })).toBeVisible();

    const hours = owner.locator("#availability").getByRole("form", { name: "Weekly hours" });
    await hours.getByRole("checkbox", { name: "Saturday" }).check();
    await hours.getByLabel("Saturday from").fill("08:00");
    await hours.getByLabel("Saturday until").fill("11:00");
    await hours.getByRole("button", { name: "Save weekly hours" }).click();
    await expect(hours.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  });

  test("residents see nothing until their community approves the vendor, then only public details", async () => {
    await resident.goto("/app");
    await selectOrganization(resident, communityName);
    await nav(resident).getByRole("link", { name: "Find services" }).click();
    await expect(resident.getByRole("heading", { level: 1, name: "Find activities and services" })).toBeVisible();
    await expect(resident.getByText("Nothing to show yet")).toBeVisible();
    await expect(nav(resident).getByRole("link", { name: "Community vendors" })).toHaveCount(0); // residents do not approve vendors

    await admin.goto("/app");
    await selectOrganization(admin, communityName);
    await nav(admin).getByRole("link", { name: "Community vendors" }).click();
    await expect(admin.getByRole("heading", { level: 1, name: `Vendors for ${communityName}` })).toBeVisible();
    const row = admin.locator("li", { hasText: vendorName });
    await expect(row.getByText("Waiting for your decision")).toBeVisible();
    await expect(admin.getByText("Asha Sports LLP")).toHaveCount(0); // private business details are not for approvers
    // exact: "Do not approve <name>" also contains "approve <name>", and name matching ignores case
    await row.getByRole("button", { name: `Approve ${vendorName}`, exact: true }).click();
    await expect(row.getByText("Approved", { exact: true })).toBeVisible();

    await resident.reload();
    const card = resident.locator("li", { hasText: "Weekend cricket camp" }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText("₹500")).toBeVisible();
    await expect(card.getByText("Per child")).toBeVisible();
    await expect(card.getByRole("link", { name: vendorName })).toBeVisible();

    // filters
    await resident.getByLabel("Child's age").fill("15");
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(resident.getByText("Try a different search.")).toBeVisible();
    await resident.getByLabel("Child's age").fill("8");
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(resident.locator("li", { hasText: "Weekend cricket camp" }).first()).toBeVisible();

    // the vendor page shows public details and offerings, never private ones
    await resident.locator("li", { hasText: "Weekend cricket camp" }).first().getByRole("link", { name: vendorName }).click();
    await expect(resident.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
    await expect(resident.getByText("Cricket and football coaching for children aged 6 to 12.")).toBeVisible();
    await expect(resident.getByText("Weekend cricket camp").first()).toBeVisible();
    await expect(resident.getByText("Asha Sports LLP")).toHaveCount(0);
    await expect(resident.getByText("asha@example.test")).toHaveCount(0);
  });

  test("withdrawing approval hides the vendor again at once, and suspension does too", async () => {
    await admin.reload();
    const row = admin.locator("li", { hasText: vendorName });
    await row.getByLabel(`Note about ${vendorName}`).fill("Parent complaint under review.");
    await row.getByRole("button", { name: `Withdraw approval for ${vendorName}` }).click();
    await expect(row.getByText("Approval withdrawn")).toBeVisible();
    await resident.goto("/app/catalog");
    await expect(resident.getByText("Nothing to show yet")).toBeVisible();

    await row.getByRole("button", { name: `Approve ${vendorName}`, exact: true }).click();
    await expect(row.getByText("Approved", { exact: true })).toBeVisible();
    await resident.reload();
    await expect(resident.locator("li", { hasText: "Weekend cricket camp" }).first()).toBeVisible();

    await ops.goto(vendorUrl);
    const status = ops.locator("#status");
    await status.getByLabel("Note").fill("Investigating a complaint.");
    await status.getByRole("button", { name: "Suspend vendor" }).click();
    await expect(status.getByText("Suspended", { exact: true }).first()).toBeVisible();
    await resident.reload();
    await expect(resident.getByText("Nothing to show yet")).toBeVisible();
    // the vendor's own people are switched off as well
    await owner.goto("/app");
    await expect(owner.getByText("An organization of yours is suspended")).toBeVisible();
    await status.getByLabel("Note").fill("Cleared.");
    await status.getByRole("button", { name: "Reinstate vendor" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();
  });

  test("a required document that lapses hides the vendor and is flagged; renewing it brings the vendor back", async () => {
    const vendorId = vendorUrl.split("/").pop() ?? "";
    await sql("UPDATE vendor_documents SET expires_on = current_date - 1 WHERE tenant_id = $1 AND requirement_key = 'background_check'", [vendorId]);

    await resident.goto("/app/catalog");
    await expect(resident.getByText("Nothing to show yet")).toBeVisible(); // hidden at once

    await ops.goto("/app/vendors");
    await ops.getByLabel("Documents").selectOption("lapsed");
    await ops.getByRole("button", { name: "Search" }).click();
    const row = ops.getByRole("row", { name: new RegExp(vendorName) });
    await expect(row).toContainText("Lapsed: hidden from families");

    await owner.goto(vendorUrl);
    await expect(owner.locator("#status").getByText("Hidden from families until your documents are renewed")).toBeVisible();
    const form = owner.locator("#documents").getByRole("form", { name: "Submit a document" });
    await form.getByLabel("Document type").selectOption({ label: "Background check (required)" });
    await form.getByLabel("Title").fill("Renewed police verification");
    await form.getByLabel("Expires on").fill(new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10));
    await form.getByRole("button", { name: "Submit document" }).click();
    await expect(owner.locator("#documents").locator("strong", { hasText: "Renewed police verification" })).toBeVisible();
    await resident.reload();
    await expect(resident.getByText("Nothing to show yet")).toBeVisible(); // submitting is not enough

    await ops.goto(vendorUrl);
    await ops.locator("#documents").getByRole("button", { name: "Verify Renewed police verification" }).click();
    await expect(ops.locator("#documents").getByRole("button", { name: "Verify Renewed police verification" })).toHaveCount(0);
    await resident.reload();
    await expect(resident.locator("li", { hasText: "Weekend cricket camp" }).first()).toBeVisible();
    await owner.reload();
    await expect(owner.locator("#status").getByText("Hidden from families until your documents are renewed")).toHaveCount(0);
  });

  test("a family can save an activity, find it under saved, narrow by price and rating, and remove it", async () => {
    await resident.goto("/app/catalog");
    const camp = () => resident.locator("li", { hasText: "Weekend cricket camp" }).first();
    await expect(camp().getByText("No reviews yet")).toBeVisible();

    // save: the button says what it will do next, and the result is announced
    await camp().getByRole("button", { name: "Save (Weekend cricket camp)", exact: true }).click();
    await expect(camp().getByRole("button", { name: "Remove from saved (Weekend cricket camp)", exact: true })).toBeVisible();
    await expect(camp().getByRole("status")).toContainText("Saved Weekend cricket camp.");

    // it is still saved after a reload, and the saved filter finds it
    await resident.reload();
    await expect(camp().getByRole("button", { name: "Remove from saved (Weekend cricket camp)", exact: true })).toBeVisible();
    await resident.getByLabel("Only the activities I have saved").check();
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(camp()).toBeVisible();

    // price and rating narrow the list (the offering costs 500 and the vendor has no reviews yet)
    await resident.getByLabel("Only the activities I have saved").uncheck();
    await resident.getByLabel("Highest price (₹)").fill("400");
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(resident.getByText("Try a different search.")).toBeVisible();
    await resident.getByLabel("Highest price (₹)").fill("600");
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(camp()).toBeVisible();
    await resident.getByLabel("Rating", { exact: true }).selectOption("4");
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(resident.getByText("Try a different search.")).toBeVisible();
    await resident.getByLabel("Rating", { exact: true }).selectOption("");
    await resident.getByLabel("Highest price (₹)").fill("");

    // removing it from the vendor page works too, and the saved list says so when it is empty
    await resident.getByRole("button", { name: "Search" }).click();
    await camp().getByRole("link", { name: vendorName }).click();
    await expect(resident.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
    await resident.getByRole("button", { name: "Remove from saved (Weekend cricket camp)", exact: true }).click();
    await expect(resident.getByRole("button", { name: "Save (Weekend cricket camp)", exact: true })).toBeVisible();
    await resident.goto("/app/catalog");
    await resident.getByLabel("Only the activities I have saved").check();
    await resident.getByRole("button", { name: "Search" }).click();
    await expect(resident.getByText("You have not saved any activities yet.")).toBeVisible();

    // leave one saved so the accessibility scan below covers the saved state as well
    await resident.getByLabel("Only the activities I have saved").uncheck();
    await resident.getByRole("button", { name: "Search" }).click();
    await camp().getByRole("button", { name: "Save (Weekend cricket camp)", exact: true }).click();
    await expect(camp().getByRole("button", { name: "Remove from saved (Weekend cricket camp)", exact: true })).toBeVisible();
  });

  test("every new screen passes the accessibility scan in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const p of [ops, admin, owner, resident]) await p.emulateMedia({ colorScheme: scheme });

      await ops.goto("/app/vendors");
      await expect(ops.getByRole("table", { name: "Vendors" })).toBeVisible();
      await expectNoAxeViolations(ops, `vendors list (${scheme})`);
      await ops.goto("/app/vendors/new");
      await expectNoAxeViolations(ops, `register vendor (${scheme})`);
      await ops.goto(vendorUrl);
      await expect(ops.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
      await expect(ops.locator("#availability").getByRole("form", { name: "Weekly hours" })).toBeVisible();
      await expectNoAxeViolations(ops, `vendor detail as platform staff (${scheme})`);

      await owner.goto("/app");
      await selectOrganization(owner, vendorName);
      await owner.goto(vendorUrl);
      await expect(owner.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
      await expect(owner.locator("#availability").getByRole("form", { name: "Weekly hours" })).toBeVisible();
      await expectNoAxeViolations(owner, `vendor workspace as the vendor (${scheme})`);

      await admin.goto("/app/community-vendors");
      await expect(admin.getByRole("heading", { level: 1, name: `Vendors for ${communityName}` })).toBeVisible();
      await expect(admin.locator("li", { hasText: vendorName })).toBeVisible();
      await expectNoAxeViolations(admin, `community vendors (${scheme})`);

      await resident.goto("/app/catalog");
      await expect(resident.locator("li", { hasText: "Weekend cricket camp" }).first()).toBeVisible();
      await expectNoAxeViolations(resident, `catalog (${scheme})`);
      await resident.locator("li", { hasText: "Weekend cricket camp" }).first().getByRole("link", { name: vendorName }).click();
      await expect(resident.getByRole("heading", { level: 1, name: vendorName })).toBeVisible();
      await expectNoAxeViolations(resident, `catalog vendor page (${scheme})`);
    }
  });
});

test.describe("vendor screens are not reachable without the permission", () => {
  test("a resident cannot open the platform vendor area or another vendor's workspace", async ({ page }) => {
    const email = uniqueEmail("nosy");
    await registerViaUi(page, email, "Nosy Neighbour");
    await verifyEmailInDb(email);
    await page.goto("/app/vendors");
    await expect(page.getByText("This area is for the platform team")).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Vendors" })).toHaveCount(0);
    await page.goto("/app/vendors/00000000-0000-4000-8000-0000000000aa");
    await expect(page.getByText("We could not load this vendor").or(page.getByText("Vendor not found"))).toBeVisible();
    await page.goto("/app/catalog");
    await expect(page.getByText("Choose a community")).toBeVisible();
  });
});
