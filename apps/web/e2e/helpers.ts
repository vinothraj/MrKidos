import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { base32Decode, totpAt } from "../../api/src/auth/totp";
import { ADMIN_DB_URL, MAIL_OUTBOX } from "./env";

/** Matches the "Password" field whether or not its label also says "(required)", but not "Show password". */
export const PASSWORD_LABEL = /^Password(\s*\(required\))?$/u;
export const PASSWORD = "correct-horse-battery-9";

/** The app's own danger alert. (Next.js also renders an empty role="alert" route announcer, which must not match.) */
export const alertBox = (page: Page) => page.locator('.k-alert[role="alert"]');
export const NEW_PASSWORD = "an-entirely-new-passphrase-7";

let counter = 0;
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 6)}@example.test`;
}

/** SQL access as the database superuser, for arranging fixtures only (never for the behavior under test). */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Waits for an email to `to` whose subject contains `subjectPart` and returns it. */
export async function waitForMail(to: string, subjectPart: string, after = 0): Promise<Mail> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(MAIL_OUTBOX, "utf8")).split("\n").filter(Boolean);
      const mails = lines.map((l) => JSON.parse(l) as Mail).filter((m) => m.to === to && m.subject.includes(subjectPart));
      if (mails.length > after) return mails[mails.length - 1] as Mail;
    } catch {
      // outbox not created yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email to ${to} containing "${subjectPart}"`);
}

export function linkFrom(mail: Mail): string {
  const m = /(https?:\/\/[^\s]+)/u.exec(mail.text);
  if (!m?.[1]) throw new Error("No link in email");
  return m[1];
}

export const PLATFORM_ORG = "00000000-0000-4000-8000-000000000001";

/** Marks an email as verified directly in the database (the real emailed-link flow has its own tests). */
export async function verifyEmailInDb(email: string): Promise<void> {
  await sql("UPDATE users SET email_verified_at = now() WHERE lower(email) = lower($1)", [email]);
}

/** Makes an existing user platform staff holding a platform role (arrangement only). */
export async function grantPlatformRole(email: string, roleKey: string): Promise<void> {
  const rows = await sql<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`user not found: ${email}`);
  await sql("INSERT INTO platform_staff (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  await sql("INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [PLATFORM_ORG, id]);
  await sql(
    "INSERT INTO role_assignments (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3 AND tenant_id IS NULL ON CONFLICT DO NOTHING",
    [PLATFORM_ORG, id, roleKey],
  );
}

/** Registers through the UI and lands on the signed-in home page. */
export async function registerViaUi(page: Page, email: string, name = "Priya Patel"): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(PASSWORD_LABEL).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1, name: `Welcome, ${name}` })).toBeVisible();
}

export async function verifyEmailViaLink(page: Page, email: string): Promise<void> {
  const link = linkFrom(await waitForMail(email, "Verify your email"));
  await page.goto(link);
  await expect(page.getByText("Your email address is confirmed")).toBeVisible();
}

export async function signInViaUi(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(PASSWORD_LABEL).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function signOutViaUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Runs axe against WCAG 2.0, 2.1 and 2.2 level A and AA, including color contrast in the real browser. */
export async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  // Colors are transitioned (120 to 220 ms). Scanning mid-transition (for example right after a theme switch) measures
  // half-blended colors and makes contrast checks flaky, so wait for every finite animation to finish first.
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

/** Enrolls TOTP on the Security page and returns the secret plus the displayed recovery codes. */
export async function enrollMfaViaUi(page: Page): Promise<{ secret: Buffer; recoveryCodes: string[] }> {
  await page.goto("/app/security");
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  const keyText = await page.locator("text=Setup key:").locator("..").locator(".k-mono").innerText();
  const secret = base32Decode(keyText.trim());
  await page.getByLabel("6-digit code").fill(totpAt(secret, Date.now()));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Two-step verification is on")).toBeVisible();
  const codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allInnerTexts();
  await page.getByRole("button", { name: "I have saved them" }).click();
  return { secret, recoveryCodes: codes };
}

/** A code from the next time step: valid through the drift window and distinct from the one used at enrollment. */
export const nextCode = (secret: Buffer, stepsAhead = 1): string => totpAt(secret, Date.now() + stepsAhead * 30_000);
