import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Test database provisioning.
 *  - If TEST_DATABASE_ADMIN_URL is set (CI service container, or Docker via `db:up`), use it as is.
 *  - Otherwise start a throwaway embedded PostgreSQL 16 so tests run without Docker.
 * Either way the tests exercise a real PostgreSQL, never a mock.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env["TEST_DATABASE_ADMIN_URL"]) return;

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "kidos-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "kidos_admin",
    password: "kidos_dev",
    port,
    persistent: false,
    onLog: () => {},
    onError: (e) => console.error("[embedded-postgres]", e),
  });
  await pg.initialise();
  await pg.start();
  process.env["TEST_DATABASE_ADMIN_URL"] = `postgres://kidos_admin:kidos_dev@127.0.0.1:${port}/postgres`;

  return async () => {
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
