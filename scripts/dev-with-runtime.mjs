#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiRepoRoot = path.resolve(scriptDir, '..');
const runtimeRepoRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim() ?? '';
const explicitRuntimeCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const runtimeLockPath = path.join(uiRepoRoot, 'runtime.lock.json');
const defaultRuntimeCacheRoot = path.join(os.homedir(), '.agent-teams', 'runtime-cache');
const runtimeCacheRoot = process.env.CLAUDE_DEV_RUNTIME_CACHE_ROOT?.trim()
  ? path.resolve(process.env.CLAUDE_DEV_RUNTIME_CACHE_ROOT.trim())
  : defaultRuntimeCacheRoot;
const shouldPrintRuntimePath = process.argv.includes('--print-runtime-path');
const runtimeDisplayName = 'teams orchestrator';
const WINDOWS_SHELL_COMMANDS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'yarnpkg', 'corepack']);

function shouldUseWindowsShell(cmd) {
  if (process.platform !== 'win32') {
    return false;
  }

  const commandName = path.basename(cmd).toLowerCase();
  return WINDOWS_SHELL_COMMANDS.has(commandName);
}

function runOrExit(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: shouldUseWindowsShell(cmd),
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

function runAndCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: shouldUseWindowsShell(cmd),
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}${details ? `\n${details}` : ''}`);
  }

  return result.stdout?.trim() ?? '';
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

function readRuntimeLock() {
  return JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));
}

function getPlatformAssetKey() {
  const platformKey = `${process.platform}-${process.arch}`;

  switch (platformKey) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'linux-x64':
    case 'win32-x64':
      return platformKey;
    default:
      throw new Error(
        `Dev runtime bootstrap does not support this platform yet: ${process.platform}/${process.arch}`
      );
  }
}

function getReleaseAssetUrl(runtimeLock, asset) {
  const releaseTag =
    typeof runtimeLock.releaseTag === 'string' && runtimeLock.releaseTag.trim().length > 0
      ? runtimeLock.releaseTag.trim()
      : runtimeLock.sourceRef;
  return `https://github.com/${runtimeLock.releaseRepository}/releases/download/${releaseTag}/${encodeURIComponent(asset.file)}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  const visibleChars = maxLength - 3;
  const headLength = Math.ceil(visibleChars / 2);
  const tailLength = Math.floor(visibleChars / 2);
  return `${value.slice(0, headLength)}...${value.slice(value.length - tailLength)}`;
}

function buildProgressBar(progressRatio, width) {
  const safeWidth = Math.max(10, width);
  const clampedRatio = Number.isFinite(progressRatio) ? Math.min(1, Math.max(0, progressRatio)) : 0;
  const filledWidth = Math.round(safeWidth * clampedRatio);
  return `${'='.repeat(filledWidth)}${'-'.repeat(safeWidth - filledWidth)}`;
}

function supportsProgressRedraw() {
  return Boolean(process.stdout.isTTY && process.env.TERM && process.env.TERM !== 'dumb');
}

function formatProgressLine(label, writtenBytes, totalBytes, hasTotal) {
  const columns =
    process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
  const ratio = hasTotal ? writtenBytes / totalBytes : 0;
  const percentText = hasTotal ? ` ${Math.floor(ratio * 100)}%` : '';
  const bytesText = hasTotal
    ? `${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)}`
    : `${formatBytes(writtenBytes)}`;
  const barWidth = hasTotal ? Math.min(24, Math.max(10, Math.floor(columns * 0.18))) : 0;
  const barText = hasTotal ? ` [${buildProgressBar(ratio, barWidth)}]` : '';
  const fixedParts = `${barText} ${bytesText}${percentText}`.trimStart();
  const availableLabelWidth = Math.max(16, columns - fixedParts.length - 1);
  const labelText = truncateMiddle(label, availableLabelWidth);

  return `${labelText}${fixedParts ? ` ${fixedParts}` : ''}`;
}

function formatProgressSummary(writtenBytes, totalBytes, hasTotal) {
  if (hasTotal) {
    const ratio = writtenBytes / totalBytes;
    return `Runtime download ${Math.floor(ratio * 100)}% - ${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)}`;
  }

  return `Runtime download - ${formatBytes(writtenBytes)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBinaryVersion(binaryPath) {
  return runAndCapture(binaryPath, ['--version']);
}

function formatRuntimeVersionForDisplay(versionText) {
  const trimmed = versionText.trim();
  if (!trimmed) {
    return runtimeDisplayName;
  }

  const versionOnly = trimmed.replace(/\s*\([^)]*\)\s*$/, '');
  return `${versionOnly} (${runtimeDisplayName})`;
}

function isExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  if (process.platform === 'win32') {
    return fs.statSync(filePath).isFile();
  }

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isCachedBinaryValid(binaryPath, expectedVersion) {
  if (!isExecutable(binaryPath)) {
    return false;
  }

  try {
    return readBinaryVersion(binaryPath).includes(expectedVersion);
  } catch {
    return false;
  }
}

async function downloadWithProgress(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'claude-team-dev-runtime-bootstrap',
    },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download runtime asset: ${response.status} ${response.statusText}`);
  }

  const totalBytes = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  const hasTotal = Number.isFinite(totalBytes) && totalBytes > 0;
  const writer = fs.createWriteStream(destinationPath);
  const reader = response.body.getReader();
  let writtenBytes = 0;
  let lastPrintedAt = 0;
  let lastLoggedPercent = -1;
  let lastLoggedBytes = 0;
  const label = `Downloading runtime ${path.basename(destinationPath)}`;
  const canRedraw = supportsProgressRedraw();

  if (canRedraw) {
    process.stdout.write(formatProgressLine(label, 0, totalBytes, hasTotal));
  } else {
    process.stdout.write(`${label}\n`);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!writer.write(Buffer.from(value))) {
        await once(writer, 'drain');
      }
      writtenBytes += value.byteLength;

      const now = Date.now();
      if (canRedraw && (now - lastPrintedAt >= 150 || writtenBytes === totalBytes)) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(formatProgressLine(label, writtenBytes, totalBytes, hasTotal));
        lastPrintedAt = now;
      } else if (!canRedraw) {
        const nextPercent = hasTotal ? Math.floor((writtenBytes / totalBytes) * 100) : null;
        const shouldLogPercent =
          nextPercent !== null && (nextPercent === 100 || nextPercent >= lastLoggedPercent + 5);
        const shouldLogBytes =
          nextPercent === null && writtenBytes >= lastLoggedBytes + 5 * 1024 * 1024;

        if (shouldLogPercent || shouldLogBytes) {
          process.stdout.write(`${formatProgressSummary(writtenBytes, totalBytes, hasTotal)}\n`);
          if (nextPercent !== null) {
            lastLoggedPercent = nextPercent;
          } else {
            lastLoggedBytes = writtenBytes;
          }
        }
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      writer.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  if (canRedraw) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${formatProgressLine(label, writtenBytes, totalBytes, hasTotal)}\n`);
  } else if (
    (hasTotal && lastLoggedPercent < 100) ||
    (!hasTotal && writtenBytes !== lastLoggedBytes)
  ) {
    process.stdout.write(`${formatProgressSummary(writtenBytes, totalBytes, hasTotal)}\n`);
  }
}

function extractArchive(archivePath, extractDir, archiveKind) {
  ensureDir(extractDir);

  if (archiveKind === 'tar.gz') {
    runOrExit('tar', ['-xzf', archivePath, '-C', extractDir]);
    return;
  }

  if (archiveKind === 'zip') {
    if (process.platform === 'win32') {
      runOrExit('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ]);
      return;
    }

    runOrExit('unzip', ['-oq', archivePath, '-d', extractDir]);
    return;
  }

  throw new Error(`Unsupported runtime archive kind: ${archiveKind}`);
}

function findExtractedBinary(extractDir, binaryName) {
  const directCandidate = path.join(extractDir, 'runtime', binaryName);
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }

  const fallbackCandidate = path.join(extractDir, binaryName);
  if (fs.existsSync(fallbackCandidate)) {
    return fallbackCandidate;
  }

  throw new Error(`Extracted runtime archive does not contain ${binaryName}`);
}

async function acquireBootstrapLock(lockPath) {
  const waitDeadline = Date.now() + 120_000;
  let announcedWait = false;

  while (true) {
    try {
      return await fs.promises.open(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (!announcedWait) {
        process.stdout.write('Waiting for another runtime bootstrap to finish...\n');
        announcedWait = true;
      }

      if (Date.now() >= waitDeadline) {
        throw new Error(`Timed out waiting for runtime bootstrap lock: ${lockPath}`);
      }

      await sleep(750);
    }
  }
}

async function ensureBootstrappedRuntime() {
  const runtimeLock = readRuntimeLock();
  const platformKey = getPlatformAssetKey();
  const asset = runtimeLock.assets[platformKey];
  if (!asset) {
    throw new Error(`No runtime asset configured for ${platformKey}`);
  }

  const cacheDir = path.join(runtimeCacheRoot, runtimeLock.version, platformKey);
  const cachedBinaryPath = path.join(cacheDir, asset.binaryName);

  if (isCachedBinaryValid(cachedBinaryPath, runtimeLock.version)) {
    return {
      binaryPath: cachedBinaryPath,
      versionText: readBinaryVersion(cachedBinaryPath),
      sourceLabel: `cached release ${runtimeLock.sourceRef}`,
      cacheDir,
      downloaded: false,
    };
  }

  ensureDir(cacheDir);
  const lockHandle = await acquireBootstrapLock(path.join(cacheDir, '.bootstrap.lock'));

  try {
    if (isCachedBinaryValid(cachedBinaryPath, runtimeLock.version)) {
      return {
        binaryPath: cachedBinaryPath,
        versionText: readBinaryVersion(cachedBinaryPath),
        sourceLabel: `cached release ${runtimeLock.sourceRef}`,
        cacheDir,
        downloaded: false,
      };
    }

    const workDir = path.join(cacheDir, `.bootstrap-${process.pid}-${Date.now()}`);
    ensureDir(workDir);

    try {
      const archivePath = path.join(workDir, asset.file);
      await downloadWithProgress(getReleaseAssetUrl(runtimeLock, asset), archivePath);

      const extractDir = path.join(workDir, 'extracted');
      extractArchive(archivePath, extractDir, asset.archiveKind);

      const extractedBinaryPath = findExtractedBinary(extractDir, asset.binaryName);
      const nextBinaryPath = `${cachedBinaryPath}.tmp`;
      await fs.promises.copyFile(extractedBinaryPath, nextBinaryPath);

      try {
        if (process.platform !== 'win32') {
          await fs.promises.chmod(nextBinaryPath, 0o755);
        }

        await fs.promises.rm(cachedBinaryPath, { force: true });
        await fs.promises.rename(nextBinaryPath, cachedBinaryPath);

        const versionText = readBinaryVersion(cachedBinaryPath);
        if (!versionText.includes(runtimeLock.version)) {
          await fs.promises.rm(cachedBinaryPath, { force: true });
          throw new Error(
            `Bootstrapped runtime version mismatch. Expected ${runtimeLock.version}, got: ${versionText}`
          );
        }

        return {
          binaryPath: cachedBinaryPath,
          versionText,
          sourceLabel: `downloaded release ${runtimeLock.sourceRef}`,
          cacheDir,
          downloaded: true,
        };
      } finally {
        await fs.promises.rm(nextBinaryPath, { force: true });
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    await lockHandle.close();
    await fs.promises.rm(path.join(cacheDir, '.bootstrap.lock'), { force: true });
  }
}

function validateRuntimeRepoRoot(repoRoot) {
  const runtimePackageJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(runtimePackageJsonPath)) {
    console.error(`CLAUDE_DEV_RUNTIME_ROOT does not look like a repo root: ${repoRoot}`);
    process.exit(1);
  }
}

async function resolveRuntimeCli() {
  if (explicitRuntimeCliPath) {
    if (!isExecutable(explicitRuntimeCliPath)) {
      throw new Error(
        `CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH is not executable: ${explicitRuntimeCliPath}`
      );
    }

    return {
      binaryPath: explicitRuntimeCliPath,
      versionText: readBinaryVersion(explicitRuntimeCliPath),
      sourceLabel: `explicit runtime override ${explicitRuntimeCliPath}`,
    };
  }

  if (runtimeRepoRoot) {
    validateRuntimeRepoRoot(runtimeRepoRoot);
    const runtimePackageManager = readPackageManagerCommand(runtimeRepoRoot);

    runOrExit(runtimePackageManager, ['run', 'build:dev'], { cwd: runtimeRepoRoot });

    const runtimeCliPath = path.join(runtimeRepoRoot, 'cli-dev');
    return {
      binaryPath: runtimeCliPath,
      versionText: readBinaryVersion(runtimeCliPath),
      sourceLabel: `local runtime repo ${runtimeRepoRoot}`,
    };
  }

  return ensureBootstrappedRuntime();
}

async function main() {
  const resolvedRuntime = await resolveRuntimeCli();

  if (shouldPrintRuntimePath) {
    process.stdout.write(`${resolvedRuntime.binaryPath}\n`);
    return;
  }

  process.stdout.write(`Using runtime from ${resolvedRuntime.sourceLabel}\n`);
  if ('cacheDir' in resolvedRuntime && resolvedRuntime.cacheDir) {
    process.stdout.write(`Runtime cache: ${resolvedRuntime.cacheDir}\n`);
  }
  process.stdout.write(
    `Runtime version: ${formatRuntimeVersionForDisplay(resolvedRuntime.versionText)}\n`
  );

  const uiEnv = {
    ...process.env,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: resolvedRuntime.binaryPath,
  };
  delete uiEnv.CLAUDE_CLI_PATH;
  const uiPackageManager = readPackageManagerCommand(uiRepoRoot);

  runOrExit(uiPackageManager, ['exec', 'electron-vite', 'dev'], {
    cwd: uiRepoRoot,
    env: uiEnv,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
