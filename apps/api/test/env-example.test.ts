import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

/** Guards against shipping a .env.example that the application itself would reject. */
describe(".env.example", () => {
  it("is accepted by the configuration loader", () => {
    const text = readFileSync(path.resolve(__dirname, "../../../.env.example"), "utf8");
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/u)) {
      const m = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
      if (m?.[1] !== undefined && m[2] !== undefined) env[m[1]] = m[2];
    }
    const config = loadConfig(env);
    expect(config.mfaEncryptionKey).toHaveLength(32);
    expect(config.allowedOrigins).toEqual(["http://localhost:3000"]);
  });
});
