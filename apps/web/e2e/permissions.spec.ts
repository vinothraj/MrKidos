import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { enrollMfaViaUi, expectNoAxeViolations, registerViaUi, sql, uniqueEmail } from "./helpers";

const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";

async function userId(email: string): Promise<string> {
  const rows = await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error("user not found");
  return id;
}

async function makeCommunity(name: string): Promise<string> {
  const id = randomUUID();
  await sql("INSERT INTO organizations (id, type, name, status) VALUES ($1, 'community', $2, 'active')", [id, name]);
  await sql("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'seed.event.one'), ($1, 'seed.event.two')", [id]);
  return id;
}

/** Gives the signed-in user a tenant-defined role holding only audit.read in a new community. */
async function grantAuditor(email: string, orgName: string): Promise<string> {
  const org = await makeCommunity(orgName);
  const uid = await userId(email);
  await sql("UPDATE users SET email_verified_at = now() WHERE id = $1", [uid]);
  await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [org, uid]);
  const role = await sql<{ id: string }>(
    "INSERT INTO roles (tenant_id, scope_type, key, name) VALUES ($1, 'community', 'auditor', 'Auditor') RETURNING id",
    [org],
  );
  await sql("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'audit.read')", [role[0]?.id]);
  await sql("INSERT INTO role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [org, uid, role[0]?.id]);
  return org;
}

async function selectOrganization(page: Page, name: string): Promise<void> {
  await page.getByLabel("Active organization").selectOption({ label: name });
  await expect(page.getByLabel("Active organization")).toHaveValue(/[0-9a-f-]{36}/);
}

test.describe("permission-driven navigation", () => {
  test("a resident sees no staff navigation, and the audit page refuses them politely", async ({ page }) => {
    await registerViaUi(page, uniqueEmail("plainresident"));
    const nav = page.getByRole("navigation", { name: "Account" });
    await expect(nav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Security" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit log" })).toHaveCount(0);

    await page.goto("/app/audit");
    await expect(page.getByText("Choose an organization using the selector")).toBeVisible();
  });

  test("the audit link appears only once an organization where the user holds the permission is active", async ({ page }) => {
    const email = uniqueEmail("auditor");
    await registerViaUi(page, email);
    const name = `Aqualily ${Date.now().toString(36)}`;
    await grantAuditor(email, name);

    await page.goto("/app");
    const nav = page.getByRole("navigation", { name: "Account" });
    await expect(page.getByText("Choose an organization", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.locator(".k-badge", { hasText: "Auditor" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit log" })).toHaveCount(0); // permission comes with the active organization

    await selectOrganization(page, name);
    await expect(page.getByText("Choose an organization", { exact: true })).toBeHidden();
    await nav.getByRole("link", { name: "Audit log" }).click();
    await expect(page).toHaveURL(/\/app\/audit$/);
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "seed.event.one" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "seed.event.two" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveAttribute("aria-current", "page");
    await expectNoAxeViolations(page, "audit log");

    // Filters narrow the list (these seeded events belong to no area) and widen it again.
    const filters = page.getByRole("form", { name: "Filter the audit log" });
    await filters.getByLabel("Area").selectOption({ label: "Sign-in and security" });
    await expect(page.getByRole("cell", { name: "seed.event.one" })).toHaveCount(0);
    await filters.getByLabel("Area").selectOption({ label: "Everything" });
    await filters.getByLabel("When").selectOption({ label: "Last 7 days" });
    await expect(page.getByRole("cell", { name: "seed.event.one" })).toBeVisible();
    await expectNoAxeViolations(page, "audit log with filters");

    // Back to no organization: the link disappears and the page explains why.
    await page.getByLabel("Active organization").selectOption({ label: "No organization selected" });
    await expect(nav.getByRole("link", { name: "Audit log" })).toHaveCount(0);
    await expect(page.getByText("Choose an organization using the selector")).toBeVisible();
  });

  test("organizations are isolated: records of another community never appear", async ({ page }) => {
    const email = uniqueEmail("isolated");
    await registerViaUi(page, email);
    const mine = `Mine ${Date.now().toString(36)}`;
    await grantAuditor(email, mine);
    const otherOrg = await makeCommunity(`Other ${Date.now().toString(36)}`);
    await sql("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'secret.other.tenant.event')", [otherOrg]);

    await page.goto("/app");
    await selectOrganization(page, mine);
    await page.goto("/app/audit");
    await expect(page.getByRole("cell", { name: "seed.event.one" })).toBeVisible();
    await expect(page.getByText("secret.other.tenant.event")).toHaveCount(0);
  });

  test("a role that requires MFA blocks tools until the user enrolls", async ({ page }) => {
    const email = uniqueEmail("staff");
    await registerViaUi(page, email);
    const uid = await userId(email);
    await sql("UPDATE users SET email_verified_at = now() WHERE id = $1", [uid]);
    await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)", [PLATFORM_ORG, uid]);
    await sql(
      "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'platform_admin' AND tenant_id IS NULL",
      [PLATFORM_ORG, uid],
    );

    await page.goto("/app");
    await selectOrganization(page, "Platform");
    await expect(page.getByText("Two-step verification is required for your role", { exact: true })).toBeVisible();

    await page.goto("/app/audit");
    await expect(page.getByText("requires two-step verification")).toBeVisible();

    await enrollMfaViaUi(page);
    await page.goto("/app");
    await expect(page.getByText("Two-step verification is required for your role", { exact: true })).toBeHidden();
    await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Audit log" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  });
});
