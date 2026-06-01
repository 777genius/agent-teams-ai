#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = new URL("..", import.meta.url).pathname;
const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-consumer-"));

try {
  run("npm", ["run", "build"], { cwd: rootDir });
  const pack = spawnSync("npm", ["pack", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr);
    process.exit(pack.status ?? 1);
  }
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = join(rootDir, filename);

  await writeFile(
    join(tempDir, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2),
  );
  run("npm", ["install", "--silent", tarball], { cwd: tempDir });
  await writeFile(
    join(tempDir, "smoke.mjs"),
    [
      "import { createSubscriptionRuntime } from '@777genius/subscription-runtime/core';",
      "import { FileBackendCodexWorker } from '@777genius/subscription-runtime/worker-codex';",
      "import { createLocalFileBackendRuntimeAdapters } from '@777genius/subscription-runtime/store-local-file';",
      "if (typeof createSubscriptionRuntime !== 'function') throw new Error('missing core export');",
      "if (typeof FileBackendCodexWorker !== 'function') throw new Error('missing worker export');",
      "if (typeof createLocalFileBackendRuntimeAdapters !== 'function') throw new Error('missing store export');",
      "console.log('packed consumer OK');",
    ].join("\n"),
  );
  run("node", ["smoke.mjs"], { cwd: tempDir });
  await rm(tarball, { force: true });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
