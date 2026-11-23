import { Pool } from "pg";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { ConsoleMailer, FileMailer, type Mailer } from "./mailer";

function createMailer(env: string): Mailer {
  // No real email provider exists yet (arrives with the notifications milestone). Printing one-time links to the
  // console or a file is fine for development but would leak them in production, so production refuses to start.
  if (env === "production") {
    throw new Error("No email provider is configured. Production cannot start with the development console mailer.");
  }
  const outbox = process.env["MAIL_OUTBOX_FILE"];
  return outbox ? new FileMailer(outbox) : new ConsoleMailer();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const app = await buildApp({ pool, config, mailer: createMailer(config.env) }, { logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
