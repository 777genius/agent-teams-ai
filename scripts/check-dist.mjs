#!/usr/bin/env node
import { spawnSync } from "node:child_process";

run("npm", ["run", "build"]);
const status = spawnSync("git", ["status", "--porcelain", "--", "dist"], {
  encoding: "utf8",
});
if (status.status !== 0) process.exit(status.status ?? 1);
if (status.stdout.trim()) {
  console.error("dist is not up to date. Run npm run build and commit dist.");
  console.error(status.stdout);
  process.exit(1);
}
console.log("dist is up to date.");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
