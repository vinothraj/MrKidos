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

test.describe.serial("communities: from registration to residents joining", () => {
  const stamp = Date.now().toString(36);
  const communityName = `Aqualily ${stamp}`;
  const draftName = `Hidden Draft ${stamp}`;
  const opsEmail = uniqueEmail("ops");
  const adminEmail = uniqueEmail("cadmin");
  const resident1 = uniqueEmail("res1");
  const resident2 = uniqueEmail("res2");
  const resident3 = uniqueEmail("res3");
  let browserRef: Browser;
  let ops: Page;
  let admin: Page;
  let communityUrl = "";
  let inviteCode = "";

  test.beforeAll(async ({ browser }) => {
    browserRef = browser;
    ops = await newPerson(browser, opsEmail, "Olivia Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops); // platform roles require two-step verification
    admin = await newPerson(browser, adminEmail, "Asha Admin");
    await enrollMfaViaUi(admin); // community administrators require it too; done before the role arrives
  });
  test.afterAll(async () => {
    await ops.context().close();
    await admin.context().close();
  });

  test("platform staff register a community in platform mode, and non-staff cannot see the area", async () => {
    await ops.goto("/app");
    await expect(nav(ops).getByRole("link", { name: "Communities" })).toHaveCount(0); // not in platform mode yet
    const toggle = ops.getByRole("button", { name: "Platform mode" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await nav(ops).getByRole("link", { name: "Communities" }).click();
    await expect(ops.getByRole("heading", { level: 1, name: "Communities" })).toBeVisible();

    await ops.getByRole("link", { name: "Register a community" }).click();
    await expect(ops).toHaveURL(/\/app\/communities\/new$/);
    const form = ops.getByRole("form", { name: "Register a community" });
    await form.getByLabel("Community name").fill(communityName);
    await form.getByLabel("Number of homes (units)").fill("420");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("State").fill("Karnataka");
    await form.getByLabel("City").fill("Bengaluru");
    await form.getByLabel("Locality or area").fill("Whitefield");
    await form.getByLabel("Street address").fill("12 Lake Road");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Contact person").fill("Ramesh Kumar");
    await form.getByLabel("Contact email").fill("ramesh@example.test");
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("12 Lake Road")).toBeVisible(); // the review step shows what will be saved
    await form.getByRole("button", { name: "Register community" }).click();
    await expect(ops).toHaveURL(/\/app\/communities\/[0-9a-f-]{36}$/);
    communityUrl = new URL(ops.url()).pathname;
    await expect(ops.getByRole("heading", { level: 1, name: communityName })).toBeVisible();
    await expect(ops.locator("#status").getByText("Draft", { exact: true }).first()).toBeVisible();

    // A second community stays a draft so we can prove residents never see it.
    await ops.goto("/app/communities/new");
    const draftForm = ops.getByRole("form", { name: "Register a community" });
    await draftForm.getByLabel("Community name").fill(draftName);
    for (let i = 0; i < 3; i++) await draftForm.getByRole("button", { name: "Next" }).click(); // only the name is required
    await draftForm.getByRole("button", { name: "Register community" }).click();
    await expect(ops).toHaveURL(/\/app\/communities\/[0-9a-f-]{36}$/);
  });

  test("a bare community is told exactly what is missing before it can be verified", async () => {
    await expect(ops.locator("#status").getByText("Before you can submit for verification")).toBeVisible();
    // (the registration form pre-fills India, so the country is not missing; everything else is)
    await expect(ops.locator("#status").getByText("Add the state.")).toBeVisible();
    await expect(ops.locator("#status").getByText("Add the city.")).toBeVisible();
    await expect(ops.locator("#status").getByText("Add a contact email or phone number.")).toBeVisible();
    await expect(ops.locator("#status").getByRole("button", { name: "Submit for verification" })).toBeDisabled();
    await ops.goto(communityUrl);
  });

  test("the onboarding workflow runs: verify, assign an administrator, approve, activate", async () => {
    const status = ops.locator("#status");
    await status.getByRole("button", { name: "Submit for verification" }).click();
    await expect(status.getByText("In verification", { exact: true }).first()).toBeVisible();
    await expect(status.getByText("Assign at least one community administrator.")).toBeVisible();
    await expect(status.getByRole("button", { name: "Approve and activate" })).toBeDisabled();

    const admins = ops.locator("#administrators");
    await admins.getByLabel("Add an administrator by email").fill("nobody-here@example.test");
    await admins.getByRole("button", { name: "Add administrator" }).click();
    await expect(alertBox(ops)).toContainText("No account uses that email");

    await admins.getByLabel("Add an administrator by email").fill(adminEmail);
    await admins.getByRole("button", { name: "Add administrator" }).click();
    await expect(admins.getByText(adminEmail)).toBeVisible();

    await expect(status.getByRole("button", { name: "Approve and activate" })).toBeEnabled();
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(alertBox(ops)).toContainText("Add a note"); // approval needs a reason on the record
    await status.getByLabel("Note").fill("Documents and site visit checked.");
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();
    await expect(status.getByText("Documents and site visit checked.")).toBeVisible(); // in the history
  });

  test("facilities and policies are configured", async () => {
    const facilities = ops.locator("#facilities");
    const add = facilities.getByRole("form", { name: "Add a facility" });
    await add.getByLabel("Name").fill("Clubhouse");
    await add.getByLabel("Capacity (people)").fill("150");
    await add.getByRole("button", { name: "Add facility" }).click();
    await expect(facilities.locator("strong", { hasText: "Clubhouse" })).toBeVisible();
    await expect(facilities.getByText("Capacity 150")).toBeVisible();

    const policies = ops.locator("#policies");
    await policies.getByRole("checkbox", { name: "Approve events before they are confirmed" }).uncheck();
    await policies.getByRole("button", { name: "Save Approve events before they are confirmed" }).click();
    await expect(policies.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await ops.reload();
    await expect(ops.locator("#policies").getByRole("checkbox", { name: "Approve events before they are confirmed" })).not.toBeChecked();
  });

  test("a community administrator manages only their own community and creates an invite code", async () => {
    await admin.goto("/app");
    await expect(nav(admin).getByRole("link", { name: "My community" })).toHaveCount(0); // no organization selected yet
    await selectOrganization(admin, communityName);
    await expect(nav(admin).getByRole("link", { name: "Communities" })).toHaveCount(0); // community staff never see the platform list
    await nav(admin).getByRole("link", { name: "My community" }).click();
    await expect(admin.getByRole("heading", { level: 1, name: communityName })).toBeVisible();

    // they can edit the community's own settings but cannot assign administrators
    await expect(admin.locator("#administrators").getByRole("button", { name: "Add administrator" })).toHaveCount(0);
    await expect(admin.locator("#details").getByLabel("Community name")).toBeVisible();

    const invites = admin.locator("#invites");
    const form = invites.getByRole("form", { name: "Create an invite code" });
    await form.getByLabel("Label").fill("Block A");
    await form.getByLabel("Places").fill("1");
    await form.getByRole("button", { name: "Create invite code" }).click();
    const code = invites.getByTestId("new-invite-code");
    await expect(code).toBeVisible();
    inviteCode = (await code.innerText()).trim();
    expect(inviteCode).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    await expect(invites.getByRole("row", { name: /Block A/ })).toContainText("0 of 1");

    // not visible to a community administrator: other communities and the platform list
    await admin.goto("/app/communities");
    await expect(admin.getByText("This area is for the platform team")).toBeVisible();
  });

  test("a community administrator can save their details, and only the platform team has internal notes", async () => {
    await admin.goto(communityUrl);
    const adminForm = admin.getByRole("form", { name: "Community details" });
    await expect(adminForm.getByLabel("Platform team notes")).toHaveCount(0); // not even rendered for them
    await adminForm.getByLabel("About the community").fill("A friendly lakeside community.");
    await adminForm.getByRole("button", { name: "Save details" }).click();
    await expect(admin.getByText("Details saved.")).toBeVisible();

    const opsForm = ops.getByRole("form", { name: "Community details" });
    await ops.goto(communityUrl);
    await opsForm.getByLabel("Platform team notes").fill("Chairman prefers phone calls.");
    await opsForm.getByRole("button", { name: "Save details" }).click();
    await expect(ops.getByText("Details saved.")).toBeVisible();

    await admin.reload();
    await expect(admin.getByRole("form", { name: "Community details" }).getByLabel("About the community")).toHaveValue("A friendly lakeside community.");
    await expect(admin.getByText("Chairman prefers phone calls.")).toHaveCount(0);
    await expect(admin.getByRole("form", { name: "Community details" }).getByLabel("Platform team notes")).toHaveCount(0);
    await ops.reload();
    await expect(ops.getByRole("form", { name: "Community details" }).getByLabel("Platform team notes")).toHaveValue("Chairman prefers phone calls.");
  });

  test("a resident joins with the code, and the place is used up", async () => {
    const r1 = await newPerson(browserRef, resident1, "Priya Patel");
    await r1.goto("/app/join");
    await r1.getByLabel("Invite code").fill(inviteCode.toLowerCase());
    await r1.getByLabel("Your home or unit (optional)").fill("B-204");
    await r1.getByRole("button", { name: "Join community" }).click();
    await expect(r1.getByText(`Welcome to ${communityName}`)).toBeVisible();

    await r1.goto("/app");
    await expect(r1.getByRole("heading", { name: communityName })).toBeVisible();
    await expect(r1.locator(".k-badge", { hasText: "Resident" })).toBeVisible();
    await expect(r1.locator(".k-badge", { hasText: "Parent guardian" })).toBeVisible();
    await expect(nav(r1).getByRole("link", { name: "My community" })).toHaveCount(0); // residents are not administrators

    // the one place is used up: another resident gets the same generic answer as for any bad code
    const r3 = await newPerson(browserRef, resident3, "Sam Late");
    await r3.goto("/app/join");
    await r3.getByLabel("Invite code").fill(inviteCode);
    await r3.getByRole("button", { name: "Join community" }).click();
    await expect(alertBox(r3)).toContainText("not valid, has expired, or has been used up");
    await r1.context().close();
    await r3.context().close();

    await admin.goto(communityUrl);
    await expect(admin.locator("#invites").getByRole("row", { name: /Block A/ })).toContainText("1 of 1");
    await expect(admin.locator("#invites").getByRole("row", { name: /Block A/ })).toContainText("All places used");
  });

  test("a resident finds the community, asks to join, and the administrator approves", async () => {
    const r2 = await newPerson(browserRef, resident2, "Neha Nair");
    await r2.goto("/app/join");

    // a draft community is not discoverable
    await r2.getByLabel("Community name or area").fill(draftName);
    await r2.getByRole("button", { name: "Search" }).click();
    await expect(r2.getByText("No communities found")).toBeVisible();

    await r2.getByLabel("Community name or area").fill(communityName);
    await r2.getByRole("button", { name: "Search" }).click();
    await expect(r2.getByRole("heading", { name: communityName })).toBeVisible();
    await expect(r2.getByText("Whitefield, Bengaluru")).toBeVisible();
    await expect(r2.getByText("12 Lake Road")).toHaveCount(0); // private details are never in the directory
    await r2.getByRole("button", { name: `Ask to join ${communityName}` }).click();
    const request = r2.getByRole("form", { name: `Request to join ${communityName}` });
    await request.getByLabel("Your home or unit").fill("C-9");
    await request.getByLabel("A note for the administrator").fill("Moved in last month.");
    await request.getByRole("button", { name: "Send request" }).click();
    await expect(r2.getByRole("heading", { name: "Your requests" })).toBeVisible();
    await expect(r2.getByText("Waiting for approval")).toBeVisible();

    // until approved the resident has no access to the community
    await r2.goto("/app");
    await expect(r2.getByText("You are not part of a community yet")).toBeVisible();

    // the administrator sees the request, with the details needed to confirm identity
    await admin.goto(communityUrl);
    const members = admin.locator("#members");
    const row = members.getByRole("row", { name: /Neha Nair/ });
    await expect(row).toContainText("C-9");
    await expect(row).toContainText("Moved in last month.");
    await row.getByRole("button", { name: /^Approve/ }).click();
    await expect(members.getByText("There are no requests waiting.")).toBeVisible();

    await r2.reload();
    await expect(r2.getByRole("heading", { name: communityName })).toBeVisible();
    await r2.context().close();

    // suspending a member removes their access immediately
    await members.getByLabel("Show").selectOption("active");
    await members.getByRole("row", { name: /Neha Nair/ }).getByRole("button", { name: /^Suspend/ }).click();
    await members.getByLabel("Show").selectOption("suspended");
    await expect(members.getByRole("row", { name: /Neha Nair/ })).toBeVisible();
  });

  test("every new screen passes the accessibility scan in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      await ops.emulateMedia({ colorScheme: scheme });
      await admin.emulateMedia({ colorScheme: scheme });
      await ops.goto("/app/communities");
      await expect(ops.getByRole("table", { name: "Communities" })).toBeVisible();
      await expectNoAxeViolations(ops, `communities list (${scheme})`);
      await ops.goto("/app/communities/new");
      await expectNoAxeViolations(ops, `register community (${scheme})`);
      await ops.goto(communityUrl);
      await expect(ops.getByRole("heading", { level: 1, name: communityName })).toBeVisible();
      await expect(ops.locator("#members").getByRole("table", { name: "Members" }).or(ops.locator("#members").getByText("Nobody here"))).toBeVisible();
      await expectNoAxeViolations(ops, `community detail as platform staff (${scheme})`);
      await admin.goto("/app/join");
      await expectNoAxeViolations(admin, `join (${scheme})`);
    }
  });

  test("the administrator picks the community's colours; every palette passes the scan in light and dark", async () => {
    await admin.goto("/app/settings");
    await expect(admin.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    const colours = admin.getByRole("form", { name: "Community colours" });
    for (const palette of ["Forest", "Ocean", "Classic"] as const) {
      await colours.getByRole("radio", { name: new RegExp(`^${palette}`) }).check();
      await colours.getByRole("button", { name: "Save community colours" }).click();
      await expect(colours.getByText("Saved.")).toBeVisible();
      const expected = palette === "Classic" ? null : palette.toLowerCase();
      await expect.poll(() => admin.evaluate(() => document.documentElement.dataset["palette"] ?? null)).toBe(expected);
      for (const scheme of ["light", "dark"] as const) {
        await admin.emulateMedia({ colorScheme: scheme });
        await expectNoAxeViolations(admin, `settings with ${palette} (${scheme})`);
      }
    }
    await admin.emulateMedia({ colorScheme: "light" });

    // Security settings ask for confirmation, say what will happen, and can be backed out of.
    const limit = admin.getByRole("form", { name: "Longest an invite code can last" });
    await limit.getByLabel("Longest an invite code can last").selectOption("30");
    await limit.getByRole("button", { name: /^Save/ }).click();
    await expect(limit.getByText("New invite codes will stop working after at most 30 days.")).toBeVisible();
    await limit.getByRole("button", { name: "Keep it as it was" }).click();
    await expect(limit.getByLabel("Longest an invite code can last")).toHaveValue("none");
    await limit.getByLabel("Longest an invite code can last").selectOption("30");
    await limit.getByRole("button", { name: /^Save/ }).click();
    await limit.getByRole("button", { name: /^Yes, change it/ }).click();
    await expect(limit.getByText("Last changed by Asha Admin")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await admin.emulateMedia({ colorScheme: scheme });
      await expectNoAxeViolations(admin, `settings with security (${scheme})`);
    }
    await admin.emulateMedia({ colorScheme: "light" });

    // Banners: four short steps with a live preview, then the banner leads the community's Home.
    await admin.getByRole("button", { name: "New banner" }).click();
    const wizard = admin.getByRole("form", { name: "New banner" });
    await wizard.getByLabel("Headline").fill("Diwali celebration this Saturday");
    await wizard.getByLabel("Message").fill("Lights, sweets and games at the clubhouse from 6 pm.");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("radio", { name: "Family picnic" }).check();
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByLabel("Button").selectOption({ label: "Find services" });
    await wizard.getByRole("button", { name: "Next" }).click();
    await expect(wizard.getByRole("heading", { level: 3, name: "Diwali celebration this Saturday" })).toBeVisible();
    await expectNoAxeViolations(admin, "new banner preview");
    await wizard.getByRole("button", { name: "Publish banner" }).click();
    await expect(admin.getByText("Published.")).toBeVisible();
    await expect(admin.getByRole("list", { name: "Your banners" }).getByText("Showing now")).toBeVisible();

    await admin.goto("/app");
    const news = admin.getByRole("region", { name: "News from your community" });
    await expect(news.getByRole("heading", { name: "Diwali celebration this Saturday" })).toBeVisible();
    await expect(news.getByRole("link", { name: "Find services" })).toHaveAttribute("href", "/app/catalog");
    await expect(news.locator('img[src="/photos/bannerPicnic.jpg"]')).toHaveAttribute("alt", ""); // the approved photo, decorative
    for (const scheme of ["light", "dark"] as const) {
      await admin.emulateMedia({ colorScheme: scheme });
      await expectNoAxeViolations(admin, `home with a banner (${scheme})`);
    }
    await admin.emulateMedia({ colorScheme: "light" });
    await admin.goto("/app/settings");
    await admin.getByRole("button", { name: "Switch off Diwali celebration this Saturday" }).click();
    await expect(admin.getByRole("list", { name: "Your banners" }).getByText("Switched off")).toBeVisible();
    await admin.goto("/app");
    await expect(admin.getByRole("heading", { level: 1, name: /Welcome/ })).toBeVisible();
    await expect(admin.getByRole("region", { name: "News from your community" })).toHaveCount(0);

    const audit = await sql<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'community.branding_changed' AND tenant_id = (SELECT id FROM organizations WHERE name = $1)", [communityName]);
    expect(audit[0]?.n).toBe(3);
  });
});

test.describe.serial("a suspended community is switched off for its own people", () => {
  test("the administrator sees it is suspended and cannot use it, until it is reinstated", async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const name = `Pause Estates ${stamp}`;
    const opsEmail = uniqueEmail("susops");
    const adminEmail = uniqueEmail("susadm");
    const ops = await newPerson(browser, opsEmail, "Sue Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops);
    const admin = await newPerson(browser, adminEmail, "Sam Admin");
    await enrollMfaViaUi(admin);

    // set the community up quickly through the real screens
    await ops.goto("/app");
    await ops.getByRole("button", { name: "Platform mode" }).click();
    await ops.goto("/app/communities/new");
    const form = ops.getByRole("form", { name: "Register a community" });
    await form.getByLabel("Community name").fill(name);
    await form.getByLabel("Number of homes (units)").fill("100");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("State").fill("Karnataka");
    await form.getByLabel("City").fill("Bengaluru");
    await form.getByLabel("Locality or area").fill("Hebbal");
    await form.getByLabel("Street address").fill("1 Pause Road");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("Contact person").fill("Kiran");
    await form.getByLabel("Contact email").fill("kiran@example.test");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Register community" }).click();
    await expect(ops).toHaveURL(/\/app\/communities\/[0-9a-f-]{36}$/);
    const url = new URL(ops.url()).pathname;
    const status = ops.locator("#status");
    await status.getByRole("button", { name: "Submit for verification" }).click();
    await expect(status.getByText("Assign at least one community administrator.")).toBeVisible();
    await ops.locator("#administrators").getByLabel("Add an administrator by email").fill(adminEmail);
    await ops.locator("#administrators").getByRole("button", { name: "Add administrator" }).click();
    await expect(ops.locator("#administrators").getByText(adminEmail)).toBeVisible();
    await status.getByLabel("Note").fill("Checked.");
    await status.getByRole("button", { name: "Approve and activate" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();

    await admin.goto("/app"); // reload so the new organization appears for them
    await selectOrganization(admin, name);
    await admin.goto(url);
    await expect(admin.getByRole("heading", { level: 1, name })).toBeVisible();

    // the platform team suspends it
    await status.getByLabel("Note").fill("Safety review in progress.");
    await status.getByRole("button", { name: "Suspend community" }).click();
    await expect(status.getByText("Suspended", { exact: true }).first()).toBeVisible();

    // the administrator is told, cannot select it, and cannot open its pages
    await admin.goto("/app");
    await expect(admin.getByText("An organization of yours is suspended")).toBeVisible();
    await expect(admin.locator(".k-badge", { hasText: "Suspended" })).toBeVisible();
    await expect(admin.getByLabel("Active organization").locator("option", { hasText: "(suspended)" })).toHaveAttribute("disabled", "");
    await expect(nav(admin).getByRole("link", { name: "My community" })).toHaveCount(0);
    await admin.goto(url);
    await expect(admin.getByText("We could not load this community")).toBeVisible();

    // reinstated: everything returns
    await status.getByLabel("Note").fill("Review complete.");
    await status.getByRole("button", { name: "Reinstate community" }).click();
    await expect(status.getByText("Active", { exact: true }).first()).toBeVisible();
    await admin.goto("/app");
    await expect(admin.getByLabel("Active organization").locator("option", { hasText: name })).not.toHaveAttribute("disabled", "");
    await selectOrganization(admin, name);
    await admin.goto(url);
    await expect(admin.getByRole("heading", { level: 1, name })).toBeVisible();

    await ops.context().close();
    await admin.context().close();
  });
});

test.describe("family profiles", () => {
  const year = new Date().getFullYear();

  test("a guardian adds, edits, exports and erases children, with explicit consent", async ({ page }) => {
    const email = uniqueEmail("parent");
    await registerViaUi(page, email, "Parent Person");
    await verifyEmailInDb(email);
    await page.goto("/app/family");
    await expect(page.getByText("No children added yet")).toBeVisible();

    const add = page.getByRole("form", { name: "Add a child" });
    await add.getByLabel("First name or nickname").fill("Aarav");
    await add.getByLabel("Year of birth").selectOption(String(year - 7));
    await add.getByLabel("Magic and entertainment").check();
    await add.getByLabel("Science experiments").check();

    // consent is required and explained before anything is stored
    await expect(page.getByText("Only you can see this. Community administrators and vendors cannot.")).toBeVisible();
    await add.getByRole("button", { name: "Add child" }).click();
    await expect(alertBox(page)).toContainText("agree");
    await expect(page.getByRole("heading", { name: "Aarav" })).toHaveCount(0);

    await add.getByLabel(/I am this child's parent or legal guardian/).check();
    await add.getByRole("button", { name: "Add child" }).click();
    await expect(page.getByRole("heading", { name: "Aarav" })).toBeVisible();
    await expect(page.getByText("Age range 6-8")).toBeVisible();
    await expect(page.locator(".k-badge", { hasText: "Magic and entertainment" })).toBeVisible();
    // consent was recorded once, so a second child does not ask again
    await expect(page.getByLabel(/I am this child's parent or legal guardian/)).toHaveCount(0);

    // contact details are refused (data minimization)
    const second = page.getByRole("form", { name: "Add a child" });
    await second.getByLabel("First name or nickname").fill("call 9876543210");
    await second.getByLabel("Year of birth").selectOption(String(year - 3));
    await second.getByRole("button", { name: "Add child" }).click();
    await expect(second.getByText("without contact details")).toBeVisible();
    await second.getByLabel("First name or nickname").fill("Diya");
    await second.getByRole("button", { name: "Add child" }).click();
    await expect(page.getByRole("heading", { name: "Diya" })).toBeVisible();

    // edit
    await page.getByRole("button", { name: "Edit Aarav" }).click();
    const edit = page.getByRole("form", { name: "Edit Aarav" });
    await edit.getByLabel("First name or nickname").fill("Aaru");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Aaru" })).toBeVisible();

    await expectNoAxeViolations(page, "family (light)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNoAxeViolations(page, "family (dark)");
    await page.emulateMedia({ colorScheme: "light" });

    // export is a real file containing the family's data
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download my family data" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("family-data.json");
    const body = JSON.parse(await (await import("node:fs/promises")).readFile((await download.path()) ?? "", "utf8"));
    expect(body.children.map((c: { nickname: string }) => c.nickname).sort()).toEqual(["Aaru", "Diya"]);

    // remove one child, with confirmation
    await page.getByRole("button", { name: "Remove Diya" }).click();
    await page.getByRole("button", { name: "Yes, remove permanently" }).click();
    await expect(page.getByRole("heading", { name: "Diya" })).toHaveCount(0);

    // erase everything: confirmation first, then consent is needed again
    await page.getByRole("button", { name: "Erase all family data" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Aaru" })).toBeVisible();
    await page.getByRole("button", { name: "Erase all family data" }).click();
    await page.getByRole("button", { name: "Yes, erase everything" }).click();
    await expect(page.getByText("No children added yet")).toBeVisible();
    await expect(page.getByLabel(/I am this child's parent or legal guardian/)).toBeVisible();
  });

  test("children are never visible to anyone else, including a community's administrators", async ({ browser, page }) => {
    const email = uniqueEmail("privacy");
    await registerViaUi(page, email, "Private Parent");
    await verifyEmailInDb(email);
    await page.goto("/app/family");
    const add = page.getByRole("form", { name: "Add a child" });
    await add.getByLabel("First name or nickname").fill("Zorbatron");
    await add.getByLabel("Year of birth").selectOption(String(year - 5));
    await add.getByLabel(/I am this child's parent or legal guardian/).check();
    await add.getByRole("button", { name: "Add child" }).click();
    await expect(page.getByRole("heading", { name: "Zorbatron" })).toBeVisible();

    // another signed-in person sees their own (empty) family, whatever they try
    const other = await newPerson(browser, uniqueEmail("snoop"), "Snoopy");
    await other.goto("/app/family");
    await expect(other.getByText("No children added yet")).toBeVisible();
    await expect(other.getByText("Zorbatron")).toHaveCount(0);
    const res = await other.request.get("/api/v1/me/family");
    expect((await res.json()).children).toEqual([]);
    await other.context().close();
  });
});
