import { spawn } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

// One consistent environment for every isolated demo process; existing .env is untouched.
const root = path.resolve(__dirname, "..");
const action = process.argv[2];
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const commands: Record<string, string[]> = {
  api: [tsx, "src/server.ts"], dispatcher: [tsx, "src/dispatcher.ts"],
  workers: [tsx, "src/workers.ts"], reconcile: [tsx, "src/reconciliation.ts"],
  tenant: [tsx, "scripts/dashboardTenant.ts"],
  dashboard: [path.join(root, "apps/dashboard/node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3100"],
  test: [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...process.argv.slice(3)],
};
if (!commands[action]) throw new Error("Choose api, dispatcher, workers, reconcile, tenant, dashboard or test.");
let password: string;
try {
  password = parse(readFileSync(path.join(root, ".env.demo"))).POSTGRES_PASSWORD;
  if (!password || password === "replace-with-a-local-password") throw new Error("missing");
} catch {
  console.error("Local demo configuration is missing. Run npm run demo:setup first.");
  process.exit(1);
}
const child = spawn(process.execPath, commands[action], {
  cwd: action === "dashboard" ? path.join(root, "apps/dashboard") : root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: action === "test" ? "test" : "development",
    DEMO_MODE: "true",
    API_HOST: "127.0.0.1", METRICS_HOST: "127.0.0.1",
    DATABASE_URL: `postgresql://relay_demo:${encodeURIComponent(password)}@127.0.0.1:5544/relay_demo`,
    REDIS_URL: "redis://127.0.0.1:6390",
    PORT: "3200", RELAY_API_URL: "http://127.0.0.1:3200",
    DASHBOARD_ENABLED: action === "test" ? "false" : "true",
  },
});
child.on("error", () => { console.error("Could not start the demo process. Install dependencies first."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child.kill(signal); });
