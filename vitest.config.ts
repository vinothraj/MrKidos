import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  // the web app's "@/" import alias, so its components can be tested directly
  resolve: { alias: { "@": path.resolve(__dirname, "apps/web/src") } },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}", "apps/**/test/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "apps/web/e2e/**"],
    environment: "node",
    globalSetup: ["packages/db/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
