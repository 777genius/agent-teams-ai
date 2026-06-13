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
      "import { createSubscriptionRuntime } from '@vioxen/subscription-runtime/core';",
      "import { ClaudeBgProviderDriver, ClaudeRuntimeTaskExecutionEngine } from '@vioxen/subscription-runtime/provider-claude';",
      "import { FileBackendCodexWorker } from '@vioxen/subscription-runtime/worker-codex';",
      "import { createLocalFileBackendRuntimeAdapters } from '@vioxen/subscription-runtime/store-local-file';",
      "if (typeof createSubscriptionRuntime !== 'function') throw new Error('missing core export');",
      "if (typeof ClaudeBgProviderDriver !== 'function') throw new Error('missing claude provider export');",
      "if (typeof ClaudeRuntimeTaskExecutionEngine !== 'function') throw new Error('missing claude runtime engine export');",
      "if (typeof FileBackendCodexWorker !== 'function') throw new Error('missing worker export');",
      "if (typeof createLocalFileBackendRuntimeAdapters !== 'function') throw new Error('missing store export');",
      "console.log('packed consumer OK');",
    ].join("\n"),
  );
  run("node", ["smoke.mjs"], { cwd: tempDir });
  await writeFile(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
          typeRoots: [join(rootDir, "node_modules/@types")],
          types: ["node"],
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(tempDir, "smoke.ts"),
    [
      "import { createSubscriptionRuntime, DefaultRedactor, type RunnerPort } from '@vioxen/subscription-runtime/core';",
      "import { ClaudeBgProviderDriver, ClaudeRuntimeTaskExecutionEngine, sessionArtifactFromClaudeOAuth } from '@vioxen/subscription-runtime/provider-claude';",
      "import { FileBackendCodexWorker } from '@vioxen/subscription-runtime/worker-codex';",
      "import { createLocalFileBackendRuntimeAdapters } from '@vioxen/subscription-runtime/store-local-file';",
      "void createSubscriptionRuntime;",
      "void DefaultRedactor;",
      "void ClaudeBgProviderDriver;",
      "void ClaudeRuntimeTaskExecutionEngine;",
      "void sessionArtifactFromClaudeOAuth;",
      "void FileBackendCodexWorker;",
      "void createLocalFileBackendRuntimeAdapters;",
      "const _claudeDriver = new ClaudeBgProviderDriver({ engine: new ClaudeRuntimeTaskExecutionEngine() });",
      "void _claudeDriver.streamTask;",
      "const _runner: RunnerPort | null = null;",
      "void _runner;",
    ].join("\n"),
  );
  run(process.execPath, [
    join(rootDir, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "-p",
    join(tempDir, "tsconfig.json"),
  ], { cwd: tempDir });
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
