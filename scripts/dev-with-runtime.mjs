#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOrExit(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    console.error(`Failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readPackageManagerCommand(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const rawPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(rawPackageJson);
  const rawPackageManager = packageJson.packageManager;

  if (typeof rawPackageManager !== 'string' || rawPackageManager.trim().length === 0) {
    return 'pnpm';
  }

  const [packageManagerName] = rawPackageManager.trim().split('@', 1);
  if (!packageManagerName) {
    return 'pnpm';
  }

  return packageManagerName;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiRepoRoot = path.resolve(scriptDir, '..');
// Keep the dev runtime target explicit. This workspace can contain multiple
// sibling repos with the same package name, so auto-discovery is ambiguous and
// can silently point the UI at the wrong runtime after branch switches.
const runtimeRepoRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim();

if (!runtimeRepoRoot) {
  console.error(
    'CLAUDE_DEV_RUNTIME_ROOT is required for pnpm dev. ' +
      'Point it at the runtime repo root you want the UI to use in dev.'
  );
  process.exit(1);
}

const runtimePackageJsonPath = path.join(runtimeRepoRoot, 'package.json');
if (!fs.existsSync(runtimePackageJsonPath)) {
  console.error(`CLAUDE_DEV_RUNTIME_ROOT does not look like a repo root: ${runtimeRepoRoot}`);
  process.exit(1);
}

const runtimePackageManager = readPackageManagerCommand(runtimeRepoRoot);

if (process.argv.includes('--print-runtime-path')) {
  process.stdout.write(`${runtimeRepoRoot}\n`);
  process.exit(0);
}

// Respect the runtime repo's own package manager. The UI repo uses pnpm, but
// the runtime may legitimately be a Bun workspace, and forcing pnpm there can
// fail before the build even starts.
runOrExit(runtimePackageManager, ['run', 'build:dev'], { cwd: runtimeRepoRoot });

const runtimeCliPath = path.join(runtimeRepoRoot, 'cli-dev');
const uiEnv = {
  ...process.env,
  // Dev-only free-code runtime override. Keep it separate from the generic
  // CLAUDE_CLI_PATH override so switching the app into Claude CLI mode still
  // resolves the real official binary instead of this local cli-dev shim.
  CLAUDE_FREE_CODE_CLI_PATH: runtimeCliPath,
};
// If the parent shell exported a stale generic override, do not let it leak
// into the Electron main process. Claude mode must resolve the real binary.
delete uiEnv.CLAUDE_CLI_PATH;

runOrExit('pnpm', ['run', 'dev:ui'], {
  cwd: uiRepoRoot,
  env: uiEnv,
});
