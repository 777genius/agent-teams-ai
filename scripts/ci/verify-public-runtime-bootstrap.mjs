#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const runtimeLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-public-runtime-e2e-'));
const platformKey = `${process.platform}-${process.arch}`;

function fail(message, result) {
  if (result?.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result?.stderr) {
    process.stderr.write(result.stderr);
  }
  throw new Error(`[public-runtime-bootstrap-e2e] ${message}`);
}

try {
  const env = {
    ...process.env,
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: cacheRoot,
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    GH_CONFIG_DIR: path.join(cacheRoot, 'gh-config'),
  };
  delete env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  delete env.CLAUDE_DEV_RUNTIME_ROOT;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;

  const bootstrap = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'dev-with-runtime.mjs'), '--print-runtime-path'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (bootstrap.error || bootstrap.status !== 0) {
    fail(
      `anonymous bootstrap failed: ${bootstrap.error?.message ?? `exit ${bootstrap.status}`}`,
      bootstrap
    );
  }

  const outputLines = bootstrap.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const runtimePath = outputLines.at(-1) ?? '';
  if (!runtimePath || !fs.statSync(runtimePath, { throwIfNoEntry: false })?.isFile()) {
    fail(
      `bootstrap did not return an existing runtime path: ${runtimePath || '<empty>'}`,
      bootstrap
    );
  }

  const asset = runtimeLock.assets?.[platformKey];
  if (!asset) {
    fail(`runtime lock has no asset for ${platformKey}`);
  }
  const expectedRuntimePath = path.join(
    cacheRoot,
    runtimeLock.version,
    platformKey,
    asset.binaryName
  );
  if (path.resolve(runtimePath) !== path.resolve(expectedRuntimePath)) {
    fail(`expected runtime path ${expectedRuntimePath}, got ${runtimePath}`, bootstrap);
  }

  const version = spawnSync(runtimePath, ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
  });
  const versionText = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.trim();
  if (version.error || version.status !== 0 || !versionText.includes(runtimeLock.version)) {
    fail(
      `expected executable runtime ${runtimeLock.version}, got ${versionText || version.error?.message || `exit ${version.status}`}`,
      version
    );
  }

  const cachedBootstrap = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'dev-with-runtime.mjs'), '--print-runtime-path'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    }
  );
  if (cachedBootstrap.error || cachedBootstrap.status !== 0) {
    fail(
      `cached bootstrap failed: ${cachedBootstrap.error?.message ?? `exit ${cachedBootstrap.status}`}`,
      cachedBootstrap
    );
  }
  if (cachedBootstrap.stdout.includes('Downloading runtime')) {
    fail('second bootstrap downloaded the already cached runtime again', cachedBootstrap);
  }
  const cachedOutputLines = cachedBootstrap.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (path.resolve(cachedOutputLines.at(-1) ?? '') !== path.resolve(runtimePath)) {
    fail('second bootstrap did not return the same cached runtime path', cachedBootstrap);
  }

  const cacheDirEntries = fs.readdirSync(path.dirname(runtimePath));
  const staleBootstrapEntry = cacheDirEntries.find(
    (entry) => entry === '.bootstrap.lock' || entry.startsWith('.bootstrap-')
  );
  if (staleBootstrapEntry) {
    fail(`bootstrap left stale cache state: ${staleBootstrapEntry}`, cachedBootstrap);
  }

  process.stdout.write(
    `[public-runtime-bootstrap-e2e] anonymous ${process.platform}/${process.arch} bootstrap succeeded: ${versionText}\n`
  );
} finally {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
}
