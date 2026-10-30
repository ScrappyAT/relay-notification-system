import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const configPath = path.resolve(__dirname, "../.env.demo");
if (existsSync(configPath)) {
  console.log("Existing ignored .env.demo preserved. No database changes made.");
} else {
  const volume = spawnSync("docker", ["volume", "inspect", "relay-dashboard_dashboard-postgres"], { stdio: "ignore" });
  if (volume.error) {
    console.error("Start Docker Desktop before preparing the local demo configuration.");
    process.exitCode = 1;
  } else if (volume.status === 0) {
    console.error("An existing demo volume was found. Create ignored .env.demo with its existing POSTGRES_PASSWORD. No data or credentials were changed.");
    process.exitCode = 1;
  } else if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    console.error("Docker is unavailable. No configuration was written.");
    process.exitCode = 1;
  } else {
    writeFileSync(configPath, `# Local only. Do not commit.\nPOSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    console.log("Created ignored .env.demo with a random local password. No database changes made.");
  }
}
