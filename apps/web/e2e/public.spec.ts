import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./helpers";

const PAGES = [
  { path: "/", name: "home" },
  { path: "/login", name: "sign in" },
  { path: "/register", name: "register" },
  { path: "/forgot-password", name: "forgot password" },
  { path: "/reset-password?token=abc", name: "reset password (with token)" },
  { path: "/verify-email", name: "verify email (without token)" },
  { path: "/safety", name: "safety and reporting" },
  { path: "/how-it-works", name: "how it works" },
  { path: "/about", name: "about us" },
  { path: "/contact", name: "contact us" },
];

test.describe("public pages", () => {
  test("the home page states the value proposition and offers real next steps", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Discover More. Experience More. Together.");
    await expect(page.getByText("Discover extraordinary experiences, trusted services")).toBeVisible();
    await page.getByRole("link", { name: "Create your account" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page).toHaveTitle(/Create your account · Kidos/);
  });

  test("the home page walks through the journey in five numbered steps and has a full footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: "From idea to booked, in five easy steps" })).toBeVisible();
    // five steps (each step also has its own small "who does what" list, which is not a step)
    await expect(page.getByRole("list", { name: "The steps, in order" }).locator("> li")).toHaveCount(5);
    const footer = page.getByRole("contentinfo");
    for (const name of ["About us", "Contact us", "How it works", "Create account", "Sign in"]) {
      await expect(footer.getByRole("link", { name })).toBeVisible();
    }
    await footer.getByRole("link", { name: "About us" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("easy to find good things for children");
    await page.getByRole("contentinfo").getByRole("link", { name: "Contact us" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "We would love to hear from you" })).toBeVisible();
    // no contact detail is invented on any page
    await expect(page.locator('a[href^="mailto:"], a[href^="tel:"]')).toHaveCount(0);
  });

  test("the development demo tour is not served by a production build", async ({ page }) => {
    const res = await page.goto("/demo");
    expect(res?.status()).toBe(404);
  });

  test("the safety page puts the emergency numbers first, offers a way in, and shows no contact details until they are configured", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "Safety" }).click();
    await expect(page).toHaveURL(/\/safety$/);
    await expect(page.getByRole("heading", { level: 1, name: "Safety and reporting a concern" })).toBeVisible();
    // the site footer repeats the danger line on every page, so look inside the page's own content
    const content = page.getByRole("main");
    await expect(content.getByText("If a child is in danger right now")).toBeVisible();
    await expect(content.getByText("Call 112 (emergency) or 1098 (Childline) first.")).toBeVisible();
    await expect(content.getByText("It is not shown to the vendor, to your community or to other families.")).toBeVisible();
    // no contact is invented: the section appears only when the team sets an address or a number
    await expect(page.getByRole("heading", { name: "Contact the team directly" })).toHaveCount(0);
    await expect(page.locator('a[href^="mailto:"], a[href^="tel:"]')).toHaveCount(0);
    await page.getByRole("link", { name: "Sign in to report a concern" }).click();
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)app(%2F|\/)concerns$/);
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const p of PAGES) {
      test(`${p.name} has no WCAG A/AA violations (${scheme} theme)`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(p.path);
        await expect(page.locator("main")).toBeVisible();
        await expectNoAxeViolations(page, `${p.name} (${scheme})`);
      });
    }
  }

  test("the artwork is decorative (hidden from screen readers), loads without console or hydration errors, and never makes the page scroll sideways", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // the signed-out check of the session answers 401 on every public page; that is expected
      if (m.type() === "error" && !m.text().includes("Failed to load resource")) problems.push(`console: ${m.text().slice(0, 200)}`);
    });
    for (const [path, minimum] of [["/", 5], ["/login", 0], ["/register", 0]] as const) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const art = page.locator("svg.k-art, img.k-photo");
      expect(await art.count(), `artwork on ${path}`).toBeGreaterThanOrEqual(minimum);
      for (const svg of await art.all()) {
        await expect(svg).toHaveAttribute("aria-hidden", "true");
        await expect(svg).not.toHaveAttribute("role", /.+/u);
        // a photograph carries an empty description too: the text beside it says what it shows
        if ((await svg.evaluate((el) => el.tagName)) === "IMG") await expect(svg).toHaveAttribute("alt", "");
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
    expect(problems).toEqual([]);
  });

  test("the animated journey plays by itself, stops when the visitor takes over, and does not play for people who want less motion", async ({ page, browser }) => {
    const activeStep = () =>
      page.locator(".k-journey-stop").evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-current") === "step") + 1);
    await page.goto("/");
    const journey = page.getByRole("group", { name: "The journey at a glance" });
    await journey.scrollIntoViewIfNeeded();
    await expect(journey.getByRole("button")).toHaveCount(6); // five steps and the pause button
    expect(await activeStep()).toBe(1);
    // it moves on by itself while it is on screen (about every four and a half seconds)
    await expect.poll(activeStep, { timeout: 12_000 }).toBeGreaterThan(1);
    // pressing a step takes over: it shows that step and stops moving
    await journey.getByRole("button", { name: /step 4 of 5/u }).click();
    await expect(journey.locator(".k-journey-title strong")).toHaveText("Choose one and we confirm the booking");
    await expect(journey.getByRole("button", { name: "Play the tour" })).toBeVisible();
    await page.waitForTimeout(5_500);
    expect(await activeStep()).toBe(4);
    // the numbered story below says the same
    await expect(page.locator(".k-steps > li")).toHaveCount(5);

    // a visitor who asks for less motion gets a still picture they step through, with no pause button to look for
    const calm = await browser.newContext({ reducedMotion: "reduce" });
    const quiet = await calm.newPage();
    await quiet.goto("/");
    const still = quiet.getByRole("group", { name: "The journey at a glance" });
    await still.scrollIntoViewIfNeeded();
    await expect(still.getByRole("button", { name: /Pause the tour|Play the tour/u })).toHaveCount(0);
    await quiet.waitForTimeout(5_500);
    await expect(still.locator('[aria-current="step"]')).toContainText("Ask");
    await calm.close();
  });

  test("the skip link is the first tab stop and moves focus to the main content", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard tab order is a desktop concern");
    await page.goto("/login");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("an unknown page shows a helpful not-found state", async ({ page }) => {
    const res = await page.goto("/definitely-not-here");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to the home page" })).toBeVisible();
  });

  test("security headers are present and the framework is not advertised", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("honors reduced-motion preferences", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const duration = await page.getByRole("link", { name: "Create your account" }).evaluate((el) => getComputedStyle(el).transitionDuration);
    // 0.001ms is serialized as "1e-06s"; anything under 10ms counts as effectively none.
    expect(parseFloat(duration)).toBeLessThan(0.01);
  });
});
