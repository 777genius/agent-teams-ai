#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { formatGitHubReleaseDownloadError } from './lib/github-release-download-error.mjs';
import { ensureMinimumNodeOldSpaceEnv } from './lib/node-options.mjs';
import { spawnSyncWithWindowsShell } from './lib/windows-shell-spawn.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiRepoRoot = path.resolve(scriptDir, '..');
const runtimeRepoRoot = process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim() ?? '';
const explicitRuntimeCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const runtimeLockPath = path.join(uiRepoRoot, 'runtime.lock.json');
const defaultRuntimeCacheRoot = path.join(os.homedir(), '.agent-teams', 'runtime-cache');
const runtimeCacheRoot = process.env.CLAUDE_DEV_RUNTIME_CACHE_ROOT?.trim()
  ? path.resolve(process.env.CLAUDE_DEV_RUNTIME_CACHE_ROOT.trim())
  : defaultRuntimeCacheRoot;
const scriptArgs = process.argv.slice(2);
const shouldPrintRuntimePath = scriptArgs.includes('--print-runtime-path');
const electronViteArgs = scriptArgs.filter((arg) => arg !== '--print-runtime-path' && arg !== '--');
const runtimeDisplayName = 'teams orchestrator';
const remoteDebuggingPortArg = '--remoteDebuggingPort';
const terminalPlatformRootEnv = 'CLAUDE_TERMINAL_PLATFORM_ROOT';
const legacyTerminalPlatformRootEnv = 'TERMINAL_PLATFORM_ROOT';
const terminalDaemonBinaryEnv = 'CLAUDE_TERMINAL_DAEMON_BINARY';
const organizationDemoEnv = 'AGENT_TEAMS_ORG_DEMO';

function prependPathEntries(entries) {
  const currentPath = process.env.PATH ?? '';
  const currentEntries = new Set(currentPath.split(path.delimiter).filter(Boolean));
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || currentEntries.has(entry) || !fs.existsSync(entry)) {
      continue;
    }
    nextEntries.push(entry);
  }

  if (nextEntries.length > 0) {
    process.env.PATH = [...nextEntries, currentPath].filter(Boolean).join(path.delimiter);
  }
}

function augmentRuntimeToolPath() {
  const bunInstall = process.env.BUN_INSTALL?.trim();
  const home = os.homedir();
  prependPathEntries([
    bunInstall ? path.join(bunInstall, 'bin') : '',
    home ? path.join(home, '.bun', 'bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
}

function runOrExit(cmd, args, options = {}) {
  const result = spawnSyncWithWindowsShell(cmd, args, {
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

function resolveOrganizationDemoMode() {
  const rawValue = process.env[organizationDemoEnv]?.trim().toLowerCase() ?? '';

  if (!rawValue || ['0', 'false', 'no', 'off'].includes(rawValue)) {
    return 'off';
  }

  if (['1', 'true', 'yes', 'on', 'seed', 'demo'].includes(rawValue)) {
    return 'seed';
  }

  if (['restore', 'reset'].includes(rawValue)) {
    return 'restore';
  }

  console.error(`${organizationDemoEnv} must be one of: 1, true, seed, restore, 0, false, off.`);
  process.exit(1);
}

function applyOrganizationDemoMode() {
  const demoMode = resolveOrganizationDemoMode();

  if (demoMode === 'off') {
    return false;
  }

  const seedArgs = [path.join(scriptDir, 'seed-organization-map-demo.mjs')];
  if (demoMode === 'restore') {
    seedArgs.push('--restore');
  }

  runOrExit(process.execPath, seedArgs, {
    cwd: uiRepoRoot,
    env: process.env,
  });

  return demoMode === 'restore';
}

function runAndCapture(cmd, args, options = {}) {
  const result = spawnSyncWithWindowsShell(cmd, args, {
    encoding: 'utf8',
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

function hasTerminalPlatformOverride() {
  return Boolean(
    process.env[terminalPlatformRootEnv]?.trim() ||
    process.env[legacyTerminalPlatformRootEnv]?.trim() ||
    process.env[terminalDaemonBinaryEnv]?.trim()
  );
}

function ensureTerminalPlatformRuntime(env) {
  if (hasTerminalPlatformOverride()) {
    const overrideName = process.env[terminalDaemonBinaryEnv]?.trim()
      ? terminalDaemonBinaryEnv
      : process.env[terminalPlatformRootEnv]?.trim()
        ? terminalPlatformRootEnv
        : legacyTerminalPlatformRootEnv;
    process.stdout.write(`Using terminal-platform runtime from ${overrideName}\n`);
    return;
  }

  runOrExit(process.execPath, [path.join(scriptDir, 'ensure-terminal-platform-runtime.mjs')], {
    cwd: uiRepoRoot,
    env,
  });
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

function getReleaseAssetDownload(runtimeLock, asset) {
  const releaseTag =
    typeof runtimeLock.releaseTag === 'string' && runtimeLock.releaseTag.trim().length > 0
      ? runtimeLock.releaseTag.trim()
      : runtimeLock.sourceRef;
  const url = `https://github.com/${runtimeLock.releaseRepository}/releases/download/${releaseTag}/${encodeURIComponent(asset.file)}`;
  return {
    url,
    repository: runtimeLock.releaseRepository,
    releaseTag,
    assetName: asset.file,
  };
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

function parseRemoteDebuggingPortArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === remoteDebuggingPortArg) {
      const rawPort = args[index + 1];
      const port = Number.parseInt(rawPort ?? '', 10);
      return Number.isFinite(port) && port > 0
        ? { index, valueIndex: index + 1, port, style: 'split' }
        : null;
    }

    const prefix = `${remoteDebuggingPortArg}=`;
    if (arg.startsWith(prefix)) {
      const port = Number.parseInt(arg.slice(prefix.length), 10);
      return Number.isFinite(port) && port > 0 ? { index, port, style: 'equals' } : null;
    }
  }

  return null;
}

function isTcpPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (available) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(available);
    };

    server.unref();
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => finish(true));
    });
  });
}

async function findAvailableTcpPort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    if (await isTcpPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available remote debugging port near ${preferredPort}`);
}

async function resolveElectronViteArgs(args) {
  const remoteDebuggingPort = parseRemoteDebuggingPortArg(args);
  if (!remoteDebuggingPort) {
    return args;
  }

  const availablePort = await findAvailableTcpPort(remoteDebuggingPort.port);
  if (availablePort === remoteDebuggingPort.port) {
    return args;
  }

  process.stdout.write(
    `Remote debugging port ${remoteDebuggingPort.port} is busy; using ${availablePort}.\n`
  );

  const nextArgs = [...args];
  if (remoteDebuggingPort.style === 'split') {
    nextArgs[remoteDebuggingPort.valueIndex] = String(availablePort);
  } else {
    nextArgs[remoteDebuggingPort.index] = `${remoteDebuggingPortArg}=${availablePort}`;
  }

  return nextArgs;
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

async function downloadWithProgress(download, destinationPath) {
  const response = await fetch(download.url, {
    headers: {
      'user-agent': 'claude-team-dev-runtime-bootstrap',
    },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(
      formatGitHubReleaseDownloadError({
        kind: 'runtime asset',
        response,
        lockPath: runtimeLockPath,
        notFoundHint:
          '404 usually means the runtime release or asset is missing, private, or inaccessible. If the orchestrator repository is private, run gh auth login with access to it or set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to a local runtime.',
        ...download,
      })
    );
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

function downloadReleaseAssetWithGh(download, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const result = spawnSync(
    'gh',
    [
      'release',
      'download',
      download.releaseTag,
      '--repo',
      download.repository,
      '--pattern',
      download.assetName,
      '--dir',
      path.dirname(destinationPath),
      '--clobber',
    ],
    {
      cwd: uiRepoRoot,
      encoding: 'utf8',
      env: process.env,
      shell: false,
      stdio: 'pipe',
    }
  );

  if (result.status === 0 && fs.existsSync(destinationPath)) {
    process.stdout.write(
      `Downloaded runtime ${download.assetName} from ${download.repository}@${download.releaseTag} via gh\n`
    );
    return true;
  }

  return false;
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
      const download = getReleaseAssetDownload(runtimeLock, asset);
      if (!downloadReleaseAssetWithGh(download, archivePath)) {
        await downloadWithProgress(download, archivePath);
      }

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

    const runtimeCliName = process.platform === 'win32' ? 'cli-dev.cmd' : 'cli-dev';
    const runtimeCliPath = path.join(runtimeRepoRoot, runtimeCliName);
    return {
      binaryPath: runtimeCliPath,
      versionText: readBinaryVersion(runtimeCliPath),
      sourceLabel: `local runtime repo ${runtimeRepoRoot}`,
    };
  }

  return ensureBootstrappedRuntime();
}

async function main() {
  augmentRuntimeToolPath();

  if (!shouldPrintRuntimePath && applyOrganizationDemoMode()) {
    return;
  }

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
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE?.trim() || '16',
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: resolvedRuntime.binaryPath,
  };
  ensureMinimumNodeOldSpaceEnv(uiEnv);
  delete uiEnv.CLAUDE_CLI_PATH;
  const uiPackageManager = readPackageManagerCommand(uiRepoRoot);
  const resolvedElectronViteArgs = await resolveElectronViteArgs(electronViteArgs);

  runOrExit(process.execPath, [path.join(scriptDir, 'ensure-electron-install.cjs'), '--strict'], {
    cwd: uiRepoRoot,
    env: uiEnv,
  });

  ensureTerminalPlatformRuntime(uiEnv);

  runOrExit(uiPackageManager, ['exec', 'electron-vite', 'dev', ...resolvedElectronViteArgs], {
    cwd: uiRepoRoot,
    env: uiEnv,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
