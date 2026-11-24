// Daemon entry point: node run.ts [--demo] [--port N]
import { startServer } from "./server.ts";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const pi = args.indexOf("--port");
const port = pi >= 0 ? Number(args[pi + 1]) : undefined;

const srv = await startServer({ demo, port }).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await srv.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
