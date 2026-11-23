import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_PORT, MAIL_OUTBOX, WEB_PORT, WEB_URL } from "./e2e/env";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/artifacts",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    channel: "chrome", // the Chrome already installed on the machine; no browser download needed
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, testIgnore: /mobile\.spec\.ts/ },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      testMatch: /(mobile|public)\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // PostgreSQL (embedded) + migrations + API on :4010, with email written to a file.
      command: "corepack pnpm@9.15.0 exec tsx tools/stack.ts e2e",
      cwd: root,
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: process.env["E2E_REUSE"] === "1",
      env: { MAIL_OUTBOX_FILE: MAIL_OUTBOX, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    },
    {
      // The production build of the web app, proxying /api to the e2e API.
      command: `corepack pnpm@9.15.0 exec next build && corepack pnpm@9.15.0 exec next start -p ${WEB_PORT}`,
      cwd: path.join(root, "apps/web"),
      url: `http://localhost:${WEB_PORT}`,
      timeout: 240_000,
      reuseExistingServer: process.env["E2E_REUSE"] === "1",
      env: { API_ORIGIN: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    },
  ],
});
