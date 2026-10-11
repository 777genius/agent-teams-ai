#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  getExpectedRuntimeCliVersion,
  matchesRuntimeCliVersion,
} from '../lib/runtime-cli-version.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const runtimeLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime.lock.json'), 'utf8'));
const expectedCliVersion = getExpectedRuntimeCliVersion(runtimeLock);
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-public-runtime-e2e-'));
const platformKey = `${process.platform}-${process.arch}`;

function fail(message) {
  throw new Error(`[public-runtime-bootstrap-e2e] ${message}`);
}

async function runSmokeCommand(label, command, args, env, timeoutMs, maxBuffer) {
  const startedAt = Date.now();
  process.stdout.write(`[public-runtime-bootstrap-e2e] starting ${label}\n`);
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  let error;
  let stopped = false;

  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    error = reason;
    process.stderr.write(`[public-runtime-bootstrap-e2e] ${reason.message}\n`);
    if (process.platform === 'win32' && child.pid) {
      // The bootstrap can be waiting on PowerShell or the runtime executable.
      // Killing only node.exe leaves those descendants holding its output pipes.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      killer.on('error', () => child.kill('SIGKILL'));
      killer.on('close', (code) => {
        if (code !== 0) child.kill('SIGKILL');
      });
    } else {
      try {
        // Descendants can inherit the captured pipes on POSIX as well.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  const timer = setTimeout(
    () => stop(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
    timeoutMs
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (stopped) return;
    process.stdout.write(chunk);
    stdout += chunk;
    if (Buffer.byteLength(stdout) > maxBuffer) stop(new Error(`${label} exceeded stdout limit`));
  });
  child.stderr.on('data', (chunk) => {
    if (stopped) return;
    process.stderr.write(chunk);
    stderr += chunk;
    if (Buffer.byteLength(stderr) > maxBuffer) stop(new Error(`${label} exceeded stderr limit`));
  });

  return await new Promise((resolve) => {
    child.on('error', (spawnError) => { error ??= spawnError; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      process.stdout.write(
        `[public-runtime-bootstrap-e2e] finished ${label} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (exit ${status}, signal ${signal ?? 'none'})\n`
      );
      resolve({ stdout, stderr, status, error });
    });
  });
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

  const bootstrap = await runSmokeCommand(
    'anonymous bootstrap',
    process.execPath,
    [path.join(repoRoot, 'scripts', 'dev-with-runtime.mjs'), '--print-runtime-path'],
    env,
    8 * 60_000,
    16 * 1024 * 1024
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
    'payload-v1',
    asset.binaryName
  );
  if (path.resolve(runtimePath) !== path.resolve(expectedRuntimePath)) {
    fail(`expected runtime path ${expectedRuntimePath}, got ${runtimePath}`, bootstrap);
  }

  const version = await runSmokeCommand(
    'cached runtime version',
    runtimePath,
    ['--version'],
    env,
    30_000,
    1024 * 1024
  );
  const versionText = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.trim();
  if (
    version.error ||
    version.status !== 0 ||
    !matchesRuntimeCliVersion(version.stdout, expectedCliVersion)
  ) {
    fail(
      `expected executable runtime ${runtimeLock.version} with CLI version ${expectedCliVersion}, got ${versionText || version.error?.message || `exit ${version.status}`}`,
      version
    );
  }

  const cachedBootstrap = await runSmokeCommand(
    'cached bootstrap',
    process.execPath,
    [path.join(repoRoot, 'scripts', 'dev-with-runtime.mjs'), '--print-runtime-path'],
    env,
    2 * 60_000,
    1024 * 1024
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

  const cacheDirEntries = fs.readdirSync(path.dirname(path.dirname(runtimePath)));
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
  try {
    fs.rmSync(cacheRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (error) {
    process.stderr.write(
      `[public-runtime-bootstrap-e2e] warning: failed to remove temporary cache ${cacheRoot}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
