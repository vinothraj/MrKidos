import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Ports of the throwaway stack started by `tools/stack.ts e2e` and the production build of the web app. */
export const WEB_PORT = 3010;
export const API_PORT = 4010;
export const PG_PORT = 54329;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const ADMIN_DB_URL = `postgres://kidos_admin:kidos_dev@127.0.0.1:${PG_PORT}/kidos`;
/** The API writes every outgoing email here, so tests can follow one-time links. */
export const MAIL_OUTBOX = path.resolve(here, "../test-results/mail-outbox.jsonl");
