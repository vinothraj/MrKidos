import { expect, test } from "@playwright/test";
import {
  expectNoAxeViolations,
  enrollMfaViaUi,
  nextCode,
  registerViaUi,
  signInViaUi,
  signOutViaUi,
  uniqueEmail,
  verifyEmailViaLink,
  PASSWORD, PASSWORD_LABEL, alertBox } from "./helpers";

test.describe("two-step verification", () => {
  test("enroll, then every sign-in needs the second step; recovery codes work once", async ({ page }) => {
    const email = uniqueEmail("mfa");
    await registerViaUi(page, email);
    await verifyEmailViaLink(page, email);

    const { secret, recoveryCodes } = await enrollMfaViaUi(page);
    expect(recoveryCodes).toHaveLength(10);
    await expect(page.getByText("On", { exact: true })).toBeVisible();
    await signOutViaUi(page);

    // Password alone is not enough: the app stops at the verification step.
    await signInViaUi(page, email);
    await expect(page).toHaveURL(/\/login\/mfa$/);
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    await expectNoAxeViolations(page, "mfa verify");

    // ...and cannot be skipped by navigating directly.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login\/mfa$/);

    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(alertBox(page)).toContainText("not valid");

    await page.getByLabel("Authentication code").fill(nextCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await signOutViaUi(page);

    // A recovery code signs in once, and only once.
    const recovery = recoveryCodes[0] ?? "";
    await signInViaUi(page, email);
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.getByLabel("Recovery code").fill(recovery);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await signOutViaUi(page);

    await signInViaUi(page, email);
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.getByLabel("Recovery code").fill(recovery);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(alertBox(page)).toContainText("not valid");
  });

  test("cancelling at the verification step signs the half-open session out", async ({ page }) => {
    const email = uniqueEmail("mfacancel");
    await registerViaUi(page, email);
    await enrollMfaViaUi(page);
    await signOutViaUi(page);
    await signInViaUi(page, email);
    await page.getByRole("button", { name: "Cancel and sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("the enrollment screen is accessible and explains each step", async ({ page }) => {
    const email = uniqueEmail("mfaa11y");
    await registerViaUi(page, email);
    await page.goto("/app/security");
    await page.getByRole("button", { name: "Set up two-step verification" }).click();
    await expect(page.getByAltText("QR code for adding this account to your authenticator app")).toBeVisible();
    await expect(page.getByText("Setup key:")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoAxeViolations(page, `mfa enrollment (${scheme})`);
    }
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Set up two-step verification" })).toBeVisible();
  });

  test("turning it off needs the password and a current code", async ({ page }) => {
    const email = uniqueEmail("mfaoff");
    await registerViaUi(page, email);
    const { secret } = await enrollMfaViaUi(page);
    await page.getByLabel(PASSWORD_LABEL).fill("wrong-password-123");
    await page.getByLabel("Current 6-digit code").fill(nextCode(secret));
    await page.getByRole("button", { name: "Turn off two-step verification" }).click();
    await expect(alertBox(page)).toContainText("password is incorrect");

    await page.getByLabel(PASSWORD_LABEL).fill(PASSWORD);
    await page.getByLabel("Current 6-digit code").fill(nextCode(secret));
    await page.getByRole("button", { name: "Turn off two-step verification" }).click();
    await expect(page.getByRole("button", { name: "Set up two-step verification" })).toBeVisible();
  });
});
