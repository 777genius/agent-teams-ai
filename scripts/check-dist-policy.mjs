#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = process.env.SUBSCRIPTION_RUNTIME_DIST_POLICY_ROOT_DIR
  ? resolve(process.env.SUBSCRIPTION_RUNTIME_DIST_POLICY_ROOT_DIR)
  : fileURLToPath(new URL("..", import.meta.url));

const result = spawnSync("git", ["ls-files", "-z", "dist"], {
  cwd: rootDir,
  encoding: "buffer",
});

if (result.error) {
  console.error(`Unable to inspect tracked dist files: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("Unable to inspect tracked dist files.");
  if (result.stderr.length > 0) {
    console.error(result.stderr.toString("utf8").trim());
  }
  process.exit(result.status ?? 1);
}

const trackedDistFiles = result.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

if (trackedDistFiles.length > 0) {
  console.error(
    `Generated dist files must not be tracked. Found ${trackedDistFiles.length} tracked dist file(s).`,
  );
  for (const file of trackedDistFiles.slice(0, 20)) console.error(`- ${file}`);
  if (trackedDistFiles.length > 20) {
    console.error(`...and ${trackedDistFiles.length - 20} more`);
  }
  process.exit(1);
}

console.log("dist policy OK.");
