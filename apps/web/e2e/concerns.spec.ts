import { expect, test, type Browser, type Page } from "@playwright/test";
import { enrollMfaViaUi, expectNoAxeViolations, grantPlatformRole, registerViaUi, sql, uniqueEmail, verifyEmailInDb } from "./helpers";

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

test.describe.serial("concerns: a family reports, the team decides, the family reads the outcome", () => {
  const stamp = Date.now().toString(36);
  const communityName = `Concern Court ${stamp}`;
  const vendorName = `Reported Vendor ${stamp}`;
  const subject = `Coach was alone with a child ${stamp}`;
  const details = "On Saturday at the club hall the coach took one child into a side room and closed the door.";
  const outcome = `We have suspended the vendor while we investigate ${stamp}.`;
  const opsEmail = uniqueEmail("cops");
  const residentEmail = uniqueEmail("cres");
  const neighbourEmail = uniqueEmail("cnei");
  let ops: Page;
  let resident: Page;
  let neighbour: Page;
  let vendorId = "";
  let communityId = "";

  test.beforeAll(async ({ browser }) => {
    ops = await newPerson(browser, opsEmail, "Olivia Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops);
    resident = await newPerson(browser, residentEmail, "Rhea Resident");
    neighbour = await newPerson(browser, neighbourEmail, "Nikhil Neighbour");

    // Arrangement only: an active community, two residents, and a vendor the community shows.
    const community = (await sql<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [communityName]))[0];
    const vendor = (await sql<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('vendor', $1, 'active') RETURNING id", [vendorName]))[0];
    if (!community || !vendor) throw new Error("organizations not created");
    communityId = community.id;
    vendorId = vendor.id;
    for (const email of [residentEmail, neighbourEmail]) {
      const userId = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]))[0]?.id;
      await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community.id, userId]);
      await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = ANY($3) AND tenant_id IS NULL", [community.id, userId, ["resident", "parent_guardian"]]);
    }
    await sql("INSERT INTO vendor_profiles (tenant_id, description, city) VALUES ($1, 'Coaching for children.', 'Bengaluru')", [vendorId]);
    await sql("INSERT INTO vendor_service_areas (tenant_id, community_id) VALUES ($1, $2)", [vendorId, communityId]);
    await sql("INSERT INTO vendor_vetting_summary (tenant_id, complete) VALUES ($1, true)", [vendorId]);
    await sql("INSERT INTO community_vendor_approvals (tenant_id, vendor_id, status) VALUES ($1, $2, 'approved')", [communityId, vendorId]);
  });
  test.afterAll(async () => {
    for (const p of [ops, resident, neighbour]) await p.context().close();
  });

  test("a family reports a concern from a vendor's page, with emergency numbers first, and sees it was received", async () => {
    await resident.goto("/app");
    await selectOrganization(resident, communityName);
    await resident.goto(`/app/catalog/vendors/${vendorId}`);
    await resident.getByRole("link", { name: `Report a concern about ${vendorName}` }).click();
    await expect(resident.getByRole("heading", { level: 1, name: "Report a concern" })).toBeVisible();
    await expect(resident.getByText("If a child is in danger right now")).toBeVisible();
    await expect(resident.getByText("Call 112 (emergency) or 1098 (Childline) first.")).toBeVisible();
    await expect(resident.getByText(vendorName).first()).toBeVisible();
    await expect(resident.getByText("It is not shown to the vendor, to your community or to other families.")).toBeVisible();

    // the form is checked, and the button waits until the essentials are filled in
    const send = resident.getByRole("button", { name: "Send report" });
    await expect(send).toBeDisabled();
    await resident.getByLabel("What is it about?").selectOption({ label: "A child's safety" });
    await resident.getByLabel("In a few words").fill(subject);
    await resident.getByLabel("What happened?").fill(details);
    await expect(send).toBeEnabled();
    await send.click();

    await expect(resident.getByText("Thank you. We have your report.")).toBeVisible();
    const mine = resident.locator("li", { hasText: subject });
    await expect(mine).toContainText("Received");
    await expect(mine).toContainText(`about ${vendorName}`);
  });

  test("a neighbour has the same page but sees none of it", async () => {
    await neighbour.goto("/app");
    await selectOrganization(neighbour, communityName);
    await nav(neighbour).getByRole("link", { name: "Report a concern" }).click();
    await expect(neighbour.getByRole("heading", { level: 1, name: "Report a concern" })).toBeVisible();
    await expect(neighbour.getByText("You have not sent any reports.")).toBeVisible();
    await expect(neighbour.getByText(subject)).toHaveCount(0);
  });

  test("the team is told it is waiting, reads who sent it, takes it on, and decides with words for the reporter", async () => {
    await ops.goto("/app");
    await ops.getByRole("button", { name: "Platform mode" }).click();
    await expect(ops.getByText(/child-safety reports? needs? a decision/u)).toBeVisible();
    await nav(ops).getByRole("link", { name: "Concerns" }).click();
    await expect(ops.getByRole("heading", { level: 1, name: "Concerns" })).toBeVisible();

    const row = ops.locator("li", { hasText: subject });
    await expect(row).toContainText("A child's safety");
    await expect(row).toContainText("Needs a decision");
    await expect(row).toContainText("Reported by Rhea Resident");
    await expect(row).toContainText(residentEmail);
    await expect(row).toContainText(details);
    await expect(row.getByRole("link", { name: vendorName })).toBeVisible();

    // a decision needs words for the reporter
    const resolved = row.getByRole("button", { name: /Mark resolved/u });
    await expect(resolved).toBeDisabled();
    await row.getByRole("button", { name: /Start looking/u }).click();
    await expect(ops.getByText(`Now being looked at: ${subject}`)).toBeVisible();
    await expect(row).toContainText("Being looked at");
    await row.getByLabel(/Outcome for the reporter/u).fill(outcome);
    await expect(resolved).toBeEnabled();
    await resolved.click();
    // it leaves "needs a decision", and the team is told what happened instead of watching it vanish
    await expect(ops.getByText(`Marked resolved, and the reporter can now read the outcome: ${subject}`)).toBeVisible();
    await expect(ops.locator("li", { hasText: subject })).toHaveCount(0);
    await ops.getByLabel("Show").selectOption("resolved");
    const decided = ops.locator("li", { hasText: subject });
    await expect(decided).toContainText(outcome);
    await expect(decided.getByText("What the reporter was told")).toBeVisible();
    await expect(decided).toContainText("Resolved");
  });

  test("the family reads what the team decided, in words", async () => {
    await resident.goto("/app/concerns");
    const mine = resident.locator("li", { hasText: subject });
    await expect(mine).toContainText("Decided");
    await expect(mine.getByText("What the team decided")).toBeVisible();
    await expect(mine).toContainText(outcome);
    // and still nothing for the neighbour
    await neighbour.goto("/app/concerns");
    await expect(neighbour.getByText(subject)).toHaveCount(0);
  });

  test("someone with no community sees a clear message instead of a form, and no link in the menu", async ({ browser }) => {
    const lonely = await newPerson(browser, uniqueEmail("clone"), "Lena Lonely");
    await lonely.goto("/app/concerns");
    await expect(lonely.getByText("Choose where you are acting")).toBeVisible();
    await expect(nav(lonely).getByRole("link", { name: "Report a concern" })).toHaveCount(0);
    await lonely.context().close();
  });

  test("every new screen passes the accessibility scan in light and dark, and the form fits a phone", async () => {
    // a second, still-open report so the team's controls are on screen
    const residentId = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [residentEmail]))[0]?.id;
    await sql("INSERT INTO concerns (tenant_id, reporter_id, category, subject, details, created_at) VALUES ($1, $2, 'payment', $3, 'They asked for more cash on the day.', now() - interval '3 days')", [communityId, residentId, `Overcharged ${stamp}`]);

    // and a child-safety report that has waited three days, which the team must not lose in the queue
    await sql("INSERT INTO concerns (tenant_id, reporter_id, category, subject, details, created_at) VALUES ($1, $2, 'child_safety', $3, 'Children were left unsupervised.', now() - interval '3 days')", [communityId, residentId, `Old safety report ${stamp}`]);

    for (const scheme of ["light", "dark"] as const) {
      for (const p of [ops, resident]) await p.emulateMedia({ colorScheme: scheme });
      await resident.goto("/app/concerns");
      await expect(resident.getByRole("form", { name: "Report a concern" })).toBeVisible();
      await expect(resident.locator("li", { hasText: subject })).toBeVisible();
      await expectNoAxeViolations(resident, `report a concern (${scheme})`);
      await ops.goto("/app/concerns");
      await expect(ops.locator("li", { hasText: `Overcharged ${stamp}` })).toContainText("Needs a decision");
      const old = ops.locator("li", { hasText: `Old safety report ${stamp}` });
      await expect(old).toContainText("Waiting 3 days");
      await expect(old).toContainText("Waiting over a day");
      // an equally old report about money is not called out: only child safety is
      await expect(ops.locator("li", { hasText: `Overcharged ${stamp}` })).toContainText("Waiting 3 days");
      await expect(ops.locator("li", { hasText: `Overcharged ${stamp}` })).not.toContainText("Waiting over a day");
      // child safety first (queue items only: the breadcrumb is a list too)
      await expect(ops.locator("main li").filter({ hasText: "Waiting" }).first()).toContainText(`Old safety report ${stamp}`);
      await expectNoAxeViolations(ops, `concerns queue (${scheme})`);
      await ops.getByLabel("Show").selectOption("all");
      await expect(ops.locator("li", { hasText: subject })).toBeVisible();
      await expectNoAxeViolations(ops, `concerns, everything (${scheme})`);
    }

    await resident.setViewportSize({ width: 390, height: 844 });
    await resident.goto("/app/concerns");
    await expect(resident.getByRole("form", { name: "Report a concern" })).toBeVisible();
    const overflow = await resident.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow on the report form").toBeLessThanOrEqual(0);
    const send = await resident.getByRole("button", { name: "Send report" }).boundingBox();
    // 44px (2.75rem); a hair under is sub-pixel rounding while the page settles, as the phone tests allow for too
    expect(send?.height ?? 0, "the send button is tall enough to tap").toBeGreaterThanOrEqual(43.5);
    await expectNoAxeViolations(resident, "report a concern on a phone");
  });
});
