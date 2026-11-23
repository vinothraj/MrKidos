import { expect, test } from "@playwright/test";
import {
  PASSWORD,
  expectNoAxeViolations,
  registerViaUi,
  signInViaUi,
  signOutViaUi,
  uniqueEmail,
  verifyEmailViaLink,
  waitForMail,
  linkFrom,
  NEW_PASSWORD, PASSWORD_LABEL, alertBox } from "./helpers";

test.describe("resident journey: register, verify, sign in and out", () => {
  test("registration, email confirmation, sign-out and sign-in work end to end", async ({ page }) => {
    const email = uniqueEmail("resident");
    await registerViaUi(page, email);

    // Unverified: the home page asks for confirmation.
    await expect(page.getByText("Confirm your email address", { exact: true })).toBeVisible();
    await expect(page.getByText("You are not part of a community yet")).toBeVisible();

    await verifyEmailViaLink(page, email);
    await page.getByRole("link", { name: "Continue to your account" }).click();
    await expect(page.getByText("Confirm your email address", { exact: true })).toBeHidden();

    await signOutViaUi(page);
    await signInViaUi(page, email);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  });

  test("a wrong password shows an accessible error summary that takes focus, and reveals nothing about the account", async ({ page }) => {
    const email = uniqueEmail("wrongpw");
    await registerViaUi(page, email);
    await signOutViaUi(page);

    await signInViaUi(page, email, "not-the-right-password");
    const alert = alertBox(page);
    await expect(alert).toContainText("Email or password is incorrect.");
    await expect(alert).toBeFocused();
    await expect(page).toHaveURL(/\/login$/);

    // An address that does not exist gets the identical message.
    await signInViaUi(page, uniqueEmail("ghost"), "not-the-right-password");
    await expect(alertBox(page)).toContainText("Email or password is incorrect.");
  });

  test("registration reports field problems next to the fields", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Your name").fill("X");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel(PASSWORD_LABEL).fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(alertBox(page)).toContainText("Please check the highlighted fields.");
    const email = page.getByLabel("Email");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel(PASSWORD_LABEL)).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(page, "register with errors");
  });

  test("an existing email is rejected", async ({ page }) => {
    const email = uniqueEmail("dup");
    await registerViaUi(page, email);
    await signOutViaUi(page);
    await page.goto("/register");
    await page.getByLabel("Your name").fill("Someone Else");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(PASSWORD_LABEL).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(alertBox(page)).toContainText("already exists");
  });

  test("the password field can be revealed and hidden", async ({ page }) => {
    await page.goto("/login");
    const field = page.getByLabel(PASSWORD_LABEL);
    await field.fill("secret-value-123");
    await expect(field).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(field).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(field).toHaveAttribute("type", "password");
  });
});

test.describe("route protection", () => {
  test("signed-out visitors are sent to sign in and returned to where they were going", async ({ page }) => {
    const email = uniqueEmail("redirect");
    await registerViaUi(page, email);
    await signOutViaUi(page);

    await page.goto("/app/security");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fsecurity$/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(PASSWORD_LABEL).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/security$/);
    await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  });

  test("a hostile next= parameter cannot redirect off-site", async ({ page }) => {
    const email = uniqueEmail("openredirect");
    await registerViaUi(page, email);
    await signOutViaUi(page);
    for (const next of ["//evil.example/phish", "https://evil.example", "/\\evil.example", "/login"]) {
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel(PASSWORD_LABEL).fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/localhost:3010\/app$/);
      await signOutViaUi(page);
    }
  });

  test("a session revoked elsewhere stops working here", async ({ page, context }) => {
    const email = uniqueEmail("revoked");
    await registerViaUi(page, email);
    // Sign the same account in on a second device, then revoke the first from there.
    const other = await context.browser()?.newContext({ baseURL: "http://localhost:3010" });
    if (!other) throw new Error("no browser");
    const second = await other.newPage();
    await signInViaUi(second, email);
    await expect(second).toHaveURL(/\/app$/);
    await second.goto("/app/security");
    const rows = second.getByRole("listitem").filter({ hasText: "Last active" });
    await expect(rows).toHaveCount(2);
    // Only the other device's row has a button, so the current device cannot be signed out by mistake here.
    await expect(second.locator("main").getByRole("button", { name: "Sign out this device" })).toHaveCount(1);
    await second.locator("main").getByRole("button", { name: "Sign out this device" }).click();
    await expect(rows).toHaveCount(1);
    await other.close();

    await page.reload();
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe("signed-in pages", () => {
  test("home and security pages have no WCAG violations in light and dark", async ({ page }) => {
    const email = uniqueEmail("a11y");
    await registerViaUi(page, email);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // a new family sees where to start, with nothing ticked that is not true
      await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Join your community" })).toHaveAttribute("href", "/app/join");
      await expect(page.getByText("Turn on two-step verification (to do)")).toBeVisible();
      await expectNoAxeViolations(page, `home (${scheme})`);
      await page.goto("/app/security");
      await expect(page.getByRole("heading", { name: "Where you are signed in" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Recent sign-ins" }).getByText("This device")).toBeVisible();
      await expectNoAxeViolations(page, `security (${scheme})`);
    }
  });

  test("changing the password signs out other devices and keeps this one", async ({ page, context }) => {
    const email = uniqueEmail("chgpw");
    await registerViaUi(page, email);
    const other = await context.browser()?.newContext({ baseURL: "http://localhost:3010" });
    if (!other) throw new Error("no browser");
    const second = await other.newPage();
    await signInViaUi(second, email);
    await expect(second).toHaveURL(/\/app$/);

    await page.goto("/app/security");
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Other devices were signed out.")).toBeVisible();

    await second.reload();
    await expect(second).toHaveURL(/\/login/);
    await other.close();

    await signOutViaUi(page);
    await signInViaUi(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/app$/);
  });

  test("sign out all other devices asks first, then ends the others and keeps this one", async ({ page, context }) => {
    const email = uniqueEmail("allout");
    await registerViaUi(page, email);
    const other = await context.browser()?.newContext({ baseURL: "http://localhost:3010" });
    if (!other) throw new Error("no browser");
    const second = await other.newPage();
    await signInViaUi(second, email);
    await expect(second).toHaveURL(/\/app$/);

    await page.goto("/app/security");
    await page.getByRole("button", { name: "Sign out all other devices" }).click();
    await page.getByRole("button", { name: "Keep them signed in" }).click(); // backing out changes nothing
    await page.getByRole("button", { name: "Sign out all other devices" }).click();
    await page.getByRole("button", { name: "Yes, sign them out" }).click();
    await expect(page.getByText("1 other device was signed out.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Recent sign-ins" }).getByText("Signed out")).toBeVisible();

    await second.reload();
    await expect(second).toHaveURL(/\/login/);
    await other.close();
  });
});

test.describe("password reset", () => {
  test("forgot, reset by emailed link, then sign in with the new password", async ({ page }) => {
    const email = uniqueEmail("reset");
    await registerViaUi(page, email);
    await signOutViaUi(page);

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("we have sent a link to reset the password")).toBeVisible();

    const link = linkFrom(await waitForMail(email, "Reset your"));
    await page.goto(link);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("signed out everywhere")).toBeVisible();

    await signInViaUi(page, email, PASSWORD);
    await expect(alertBox(page)).toContainText("incorrect");
    await signInViaUi(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/app$/);

    // The same link cannot be used twice.
    await signOutViaUi(page);
    await page.goto(link);
    await page.getByLabel("New password").fill("yet-another-passphrase-3");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(alertBox(page)).toContainText("invalid or has expired");
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();
  });

  test("asking for a reset for an unknown address looks identical", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(uniqueEmail("nobody"));
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("we have sent a link to reset the password")).toBeVisible();
  });
});
