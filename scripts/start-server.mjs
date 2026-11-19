import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHttpControlServer } from "../server/http/src/index.ts";

const database = process.env.CCRF_EVENT_DB;
if (database) mkdirSync(dirname(database), { recursive: true, mode: 0o700 });

const app = createHttpControlServer({
  host: process.env.CCRF_BIND_HOST ?? process.env.CCRF_HOST ?? "127.0.0.1",
  port: Number(process.env.CCRF_BIND_PORT ?? process.env.CCRF_PORT ?? "8787"),
  authToken: process.env.CCRF_AUTH_TOKEN,
  totpSecret: process.env.CCRF_TOTP_SECRET,
  version: process.env.CCRF_VERSION ?? "0.1.0",
});

await app.start();
const address = app.address();
process.stdout.write(`CCRF_SERVER_READY host=${address?.host} port=${address?.port}\n`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
