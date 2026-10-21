import { config, validateServerConfiguration } from "./config";
import { app } from "./app";
import { pool } from "./database";

async function start(): Promise<void> {
  validateServerConfiguration();
  await pool.query("SELECT 1");
  const server = app.listen(config.PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${config.PORT}`);
  });
  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    console.log("Finishing active requests before shutdown");
    const timeout = setTimeout(() => process.exit(1), 20000);
    timeout.unref();
    server.close(() => {
      void pool.end().then(() => { clearTimeout(timeout); }).catch(() => { process.exitCode = 1; });
    });
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.on("error", () => {
    console.error("HTTP server failed to start");
    void pool.end().finally(() => { process.exitCode = 1; });
  });
}

start().catch(() => {
  console.error("Startup failed: check environment configuration and database connectivity");
  void pool.end().finally(() => { process.exitCode = 1; });
});
