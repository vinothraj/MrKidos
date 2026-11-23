// Bundles the API into apps/api/dist (server.mjs and migrate.mjs). npm dependencies stay external (installed in the
// image with `pnpm deploy --prod`); workspace packages (@kidos/db) are bundled in. Migrations are copied next to it.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/api/dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    server: path.join(root, "apps/api/src/server.ts"),
    migrate: path.join(root, "packages/db/src/cli.ts"),
  },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "external",
  alias: { "@kidos/db": path.join(root, "packages/db/src/index.ts") },
  logLevel: "info",
});

// migrate.ts resolves ../migrations relative to the bundle: apps/api/migrations
await cp(path.join(root, "packages/db/migrations"), path.join(root, "apps/api/migrations"), { recursive: true });
console.log("built apps/api/dist and copied migrations");
