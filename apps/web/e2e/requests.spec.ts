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

test.describe.serial("requests: from a family's ask to an approved request", () => {
  const stamp = Date.now().toString(36);
  const communityName = `Request Rise ${stamp}`;
  const title = `Magic show ${stamp}`;
  const secondTitle = `Skydiving party ${stamp}`;
  const opsEmail = uniqueEmail("rops");
  const adminEmail = uniqueEmail("radmin");
  const residentEmail = uniqueEmail("rres");
  const neighbourEmail = uniqueEmail("rnei");
  let ops: Page;
  let admin: Page;
  let resident: Page;
  let neighbour: Page;
  let requestUrl = "";

  test.beforeAll(async ({ browser }) => {
    ops = await newPerson(browser, opsEmail, "Olivia Ops");
    await grantPlatformRole(opsEmail, "super_admin");
    await enrollMfaViaUi(ops);
    admin = await newPerson(browser, adminEmail, "Asha Admin");
    await enrollMfaViaUi(admin); // community administrators require two-step verification; done before the role arrives
    resident = await newPerson(browser, residentEmail, "Rhea Resident");
    neighbour = await newPerson(browser, neighbourEmail, "Nikhil Neighbour");

    // Arrangement only: an active community with these people in it (joining and onboarding have their own journeys).
    const community = (await sql<{ id: string }>("INSERT INTO organizations (type, name, status) VALUES ('community', $1, 'active') RETURNING id", [communityName]))[0];
    if (!community) throw new Error("community not created");
    const idOf = async (email: string) => {
      const row = (await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]))[0];
      if (!row) throw new Error(`user not found: ${email}`);
      return row.id;
    };
    for (const [email, roles] of [[adminEmail, ["community_admin"]], [residentEmail, ["resident", "parent_guardian"]], [neighbourEmail, ["resident", "parent_guardian"]]] as const) {
      const userId = await idOf(email);
      await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [community.id, userId]);
      await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = ANY($3) AND tenant_id IS NULL", [community.id, userId, roles]);
    }
  });
  test.afterAll(async () => {
    for (const p of [ops, admin, resident, neighbour]) await p.context().close();
  });

  test("a family makes a request: the form is checked, and the request starts as submitted", async () => {
    await resident.goto("/app");
    await selectOrganization(resident, communityName);
    await expect(nav(resident).getByRole("link", { name: "Community requests" })).toHaveCount(0); // that view is for the community's administrators
    await expect(nav(resident).getByRole("link", { name: "Request queue" })).toHaveCount(0); // and this one for the platform team
    await nav(resident).getByRole("link", { name: "My requests" }).click();
    await expect(resident.getByRole("heading", { level: 1, name: "My requests" })).toBeVisible();
    await expect(resident.getByText("No requests here yet")).toBeVisible();
    await resident.getByRole("link", { name: "Make a request" }).click();

    const form = resident.getByRole("form", { name: "Make a request" });
    // Step 1 will not move on without a title, and says what to write.
    await expect(form.getByText("Step 1 of 4")).toBeVisible();
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("Give your request a short title")).toBeVisible();
    await form.getByLabel("Give it a short title").fill(title);
    await form.getByLabel("Tell us more").fill("A one-hour show for about fifteen children.");
    await form.getByRole("button", { name: "Next" }).click();

    // Step 2 holds this kind of request's own questions; a required one must be answered.
    await expect(form.getByRole("heading", { name: "About the activity" })).toBeVisible();
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText('Answer "One time or regular?"')).toBeVisible();
    await form.getByLabel("One time or regular?").selectOption("one_time");
    await form.getByLabel("Indoor or outdoor?").selectOption("indoor");
    await form.getByRole("button", { name: "Next" }).click();

    await form.getByLabel("Number of children").fill("15");
    await form.getByLabel("Youngest age").fill("9");
    await form.getByLabel("Oldest age").fill("5"); // wrong on purpose
    await form.getByRole("button", { name: "Next" }).click();
    await expect(form.getByText("The oldest age cannot be below the youngest.")).toBeVisible();
    await form.getByLabel("Oldest age").fill("8");
    await form.getByLabel("Youngest age").fill("5");
    await form.getByRole("button", { name: "Next" }).click();

    // The review step shows what will be sent; going back keeps every answer.
    await expect(form.getByText("Step 4 of 4")).toBeVisible();
    await expect(form.getByText("5 to 8")).toBeVisible();
    await form.getByRole("button", { name: "Back" }).click();
    await expect(form.getByLabel("Number of children")).toHaveValue("15");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Send request" }).click();

    await expect(resident).toHaveURL(/\/app\/requests\/[0-9a-f-]{36}$/);
    requestUrl = new URL(resident.url()).pathname;
    await expect(resident.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(badge(resident, "Submitted")).toBeVisible();
    await expect(resident.getByText("We are on it")).toBeVisible();
    await expect(resident.getByText("One time", { exact: true })).toBeVisible(); // answers are shown with readable labels
    // a family never sees the team's targets or owner
    await expect(resident.getByText("Target:")).toHaveCount(0);
    await expect(resident.getByRole("heading", { name: "Work this request" })).toHaveCount(0);
  });

  test("a neighbour cannot see it, by list or by address", async () => {
    await neighbour.goto("/app");
    await selectOrganization(neighbour, communityName);
    await neighbour.goto("/app/requests");
    await expect(neighbour.getByText("No requests here yet")).toBeVisible();
    await expect(neighbour.getByText(title)).toHaveCount(0);
    await neighbour.goto(requestUrl);
    await expect(neighbour.getByText("Request not found")).toBeVisible();
  });

  test("operations find it in the queue, take it, review it, and ask the family a question", async () => {
    await ops.goto("/app");
    await ops.getByRole("button", { name: "Platform mode" }).click();
    await nav(ops).getByRole("link", { name: "Request queue" }).click();
    await expect(ops.getByRole("heading", { level: 1, name: "Request queue" })).toBeVisible();
    await expect(ops.getByRole("region", { name: "Queue summary" })).toContainText("Unassigned");

    await ops.getByLabel("Search by title or number").fill(title);
    await ops.getByRole("button", { name: "Search", exact: true }).click();
    const row = ops.getByRole("row", { name: new RegExp(title) });
    await expect(row).toContainText("Submitted");
    await expect(row).toContainText("Rhea Resident");
    await expect(row).toContainText("On track");
    await row.getByRole("link", { name: title }).click();

    await expect(ops.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(ops.getByText("Target:")).toBeVisible();
    const work = ops.locator("section, div").filter({ has: ops.getByRole("heading", { name: "Work this request" }) }).last();
    await ops.getByRole("button", { name: "Take it" }).click();
    await expect(ops.getByText("Owner: Olivia Ops")).toBeVisible();
    await ops.getByRole("button", { name: "Start review" }).click();
    await expect(badge(ops, "Under review")).toBeVisible();

    // asking for information needs a note; the family can read it
    await ops.getByRole("button", { name: "Ask for more information" }).click();
    await expect(alertBox(ops)).toContainText("Add a note explaining this step");
    await ops.getByLabel("Note for this step").fill("Which weekend works, and how many are under five?");
    await ops.getByRole("button", { name: "Ask for more information" }).click();
    await expect(badge(ops, "We need more information")).toBeVisible();
    void work;

    // an internal note, for the team only
    const messages = ops.getByRole("form", { name: "Write a message" });
    await messages.getByLabel("Write a message").fill("Parent seems keen on mornings; call the magician Friday.");
    await messages.getByLabel("Internal note (only the team can see it)").check();
    await messages.getByRole("button", { name: "Add internal note" }).click();
    await expect(ops.getByText("Internal note: the family cannot see this")).toBeVisible();
  });

  test("the family reads the question, never the internal note, and replies, which returns it to review", async () => {
    await resident.reload();
    await expect(resident.getByText("The team has a question for you")).toBeVisible();
    await expect(resident.getByText("Which weekend works, and how many are under five?").first()).toBeVisible();
    await expect(resident.getByText("call the magician")).toHaveCount(0); // internal notes are invisible
    await expect(resident.getByText("Olivia Ops")).toHaveCount(0); // the family sees "the team", not names

    const reply = resident.getByRole("form", { name: "Write a message" });
    await expect(reply.getByLabel("Internal note (only the team can see it)")).toHaveCount(0); // only the team can write internal notes
    await reply.getByLabel("Your reply").fill("The 14th or 15th. Two children are under five.");
    await reply.getByRole("button", { name: "Send reply" }).click();
    await expect(badge(resident, "Under review")).toBeVisible();
    await expect(resident.getByText("The 14th or 15th. Two children are under five.")).toBeVisible();
    await expect(resident.getByText("The team has a question for you")).toHaveCount(0);
  });

  test("a community administrator reads their community's requests but cannot work them", async () => {
    await admin.goto("/app");
    await selectOrganization(admin, communityName);
    await nav(admin).getByRole("link", { name: "Community requests" }).click();
    await expect(admin.getByRole("heading", { level: 1, name: "Community requests" })).toBeVisible();
    const row = admin.getByRole("row", { name: new RegExp(title) });
    await expect(row).toContainText("Rhea Resident");
    await row.getByRole("link", { name: title }).click();
    await expect(admin.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(admin.getByText("The 14th or 15th. Two children are under five.")).toBeVisible();
    await expect(admin.getByText("call the magician")).toHaveCount(0);
    await expect(admin.getByRole("heading", { name: "Work this request" })).toHaveCount(0);
    await expect(admin.getByRole("form", { name: "Write a message" })).toHaveCount(0);
    await expect(admin.getByText("Target:")).toHaveCount(0);
  });

  test("operations approve; the family can still cancel, with a confirmation", async () => {
    await ops.reload();
    await expect(badge(ops, "Under review")).toBeVisible();
    await ops.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(badge(ops, "Approved")).toBeVisible();
    await expect(ops.getByText("Target:").locator("..").getByText("—")).toBeVisible(); // approved has no target

    await resident.reload();
    await expect(badge(resident, "Approved")).toBeVisible();
    await resident.getByRole("button", { name: "Cancel my request" }).click();
    await expect(resident.getByText("Cancel this request?")).toBeVisible();
    await resident.getByRole("button", { name: "Keep it" }).click();
    await expect(badge(resident, "Approved")).toBeVisible();
    await resident.getByRole("button", { name: "Cancel my request" }).click();
    await resident.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(badge(resident, "Cancelled")).toBeVisible();
    await expect(resident.getByRole("form", { name: "Write a message" })).toHaveCount(0); // finished: no more messages
    await expect(resident.getByRole("button", { name: "Cancel my request" })).toHaveCount(0);

    // the history tells the whole story, in order
    const history = resident.locator("section, div").filter({ has: resident.getByRole("heading", { name: "History", exact: true }) }).last();
    await expect(history.getByText("Cancelled").first()).toBeVisible();
  });

  test("a request operations cannot take on is declined with a reason the family can read", async () => {
    await resident.goto("/app/requests/new");
    const form = resident.getByRole("form", { name: "Make a request" });
    await form.getByLabel("Give it a short title").fill(secondTitle);
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByLabel("One time or regular?").selectOption("one_time");
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Next" }).click();
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(resident).toHaveURL(/\/app\/requests\/[0-9a-f-]{36}$/);
    const secondUrl = new URL(resident.url()).pathname;

    await ops.goto(secondUrl);
    await ops.getByRole("button", { name: "Cannot take this on" }).click();
    await expect(alertBox(ops)).toContainText("Add a note explaining this step");
    await ops.getByLabel("Note for this step").fill("We cannot arrange anything involving aircraft.");
    await ops.getByRole("button", { name: "Cannot take this on" }).click();
    await expect(badge(ops, "Not possible")).toBeVisible();

    await resident.reload();
    await expect(resident.getByText("We could not take this request on")).toBeVisible();
    await expect(resident.getByText("We cannot arrange anything involving aircraft.").first()).toBeVisible();
    // the family's list shows both, newest first
    await resident.goto("/app/requests");
    await expect(resident.getByRole("row", { name: new RegExp(secondTitle) })).toContainText("Not possible");
    await resident.getByLabel("Show").selectOption("open");
    await expect(resident.getByRole("row", { name: new RegExp(title) })).toHaveCount(0); // finished ones leave the open view
  });

  test("every new screen passes the accessibility scan in light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const p of [ops, admin, resident]) await p.emulateMedia({ colorScheme: scheme });

      await ops.goto("/app/requests");
      await expect(ops.getByRole("region", { name: "Queue summary" })).toBeVisible();
      await expect(ops.getByRole("table", { name: "Requests" }).or(ops.getByText("Nothing in this view"))).toBeVisible();
      await expectNoAxeViolations(ops, `request queue (${scheme})`);
      await ops.goto(requestUrl);
      await expect(ops.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expectNoAxeViolations(ops, `request detail as operations (${scheme})`);

      await admin.goto("/app/requests");
      await admin.getByLabel("Show").selectOption("all"); // both requests are finished by now, so the default open view is empty
      await expect(admin.getByRole("table", { name: "Requests" })).toBeVisible();
      await expectNoAxeViolations(admin, `community requests (${scheme})`);

      await resident.goto("/app/requests");
      await resident.getByLabel("Show").selectOption("all");
      await expect(resident.getByRole("table", { name: "Requests" })).toBeVisible();
      await expectNoAxeViolations(resident, `my requests (${scheme})`);
      await resident.goto("/app/requests/new");
      await expect(resident.getByRole("form", { name: "Make a request" })).toBeVisible();
      await expectNoAxeViolations(resident, `make a request (${scheme})`);
      await resident.goto(requestUrl);
      await expect(resident.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expectNoAxeViolations(resident, `request detail as a family (${scheme})`);
    }
  });
});

test.describe("request screens are not reachable without the right context", () => {
  test("a person who is in no community sees guidance, and the platform queue is closed to them", async ({ page }) => {
    const email = uniqueEmail("rnoone");
    await registerViaUi(page, email, "No Community");
    await verifyEmailInDb(email);
    await page.goto("/app/requests/new");
    await expect(page.getByText("Choose your community first")).toBeVisible();
    await expect(nav(page).getByRole("link", { name: /requests/i })).toHaveCount(0);
    await page.goto("/app/requests");
    await expect(page.getByRole("heading", { level: 1, name: "My requests" })).toBeVisible();
    await expect(page.getByText("We could not load the requests")).toBeVisible(); // the API refuses: no organization selected
  });
});
