import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@kidos/db/testing";
import { buildApp } from "../src/app";
import { DEV_ACCOUNTS } from "../src/dev-accounts";
import { MemoryMailer } from "../src/mailer";
import { baseConfig, call, createTestApp, type TestApp } from "./helpers";

describe("development quick sign-in", () => {
  let t: TestApp;
  let db: TestDb;
  beforeAll(async () => {
    t = await createTestApp();
    db = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
    await db.close();
  });

  it("does not exist unless the dev stack asks for it, so the real server cannot sign anyone in without a password", async () => {
    const list = await call(t.app, { method: "GET", url: "/api/v1/dev/accounts" });
    expect(list.statusCode).toBe(404);
    const login = await call(t.app, { method: "POST", url: "/api/v1/dev/login", body: { email: DEV_ACCOUNTS[0]?.email } });
    expect(login.statusCode).toBe(404);
  });

  it("refuses to be registered outside the development environment", async () => {
    await expect(
      buildApp({ pool: db.app, config: { ...baseConfig, env: "production", appBaseUrl: "https://x.example.test", allowedOrigins: ["https://x.example.test"] }, mailer: new MemoryMailer() }, { devQuickLogin: true }),
    ).rejects.toThrow(/development/u);
  });

  it("signs in only the listed accounts and never an arbitrary email", async () => {
    const dev = await createTestApp({ env: "development" });
    try {
      // buildApp in createTestApp does not opt in; build one that does.
      const app = await buildApp({ pool: dev.db.app, config: { ...baseConfig, env: "development" }, mailer: dev.mailer }, { devQuickLogin: true });
      const stranger = await call(app, { method: "POST", url: "/api/v1/dev/login", body: { email: "someone@example.test" } });
      expect(stranger.statusCode).toBe(404);
      const unseeded = await call(app, { method: "POST", url: "/api/v1/dev/login", body: { email: DEV_ACCOUNTS[0]?.email } });
      expect(unseeded.statusCode).toBe(404); // listed, but this throwaway database was never seeded
      await app.close();
    } finally {
      await dev.close();
    }
  });
});
