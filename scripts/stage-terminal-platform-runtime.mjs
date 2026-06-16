#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const lockPath = path.join(repoRoot, 'terminal-platform.lock.json');
const runtimeDir = process.env.CLAUDE_TERMINAL_PLATFORM_STAGE_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_TERMINAL_PLATFORM_STAGE_DIR.trim())
  : path.join(repoRoot, 'resources', 'terminal-platform');
const downloadRoot = process.env.CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT?.trim()
  ? path.resolve(process.env.CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT.trim())
  : path.join(repoRoot, '.terminal-platform-download');

function printUsage() {
  process.stdout.write(`Usage: node scripts/stage-terminal-platform-runtime.mjs [options]

Options:
  --platform <key>      Runtime platform key. Defaults to the current platform.
  --release-tag <tag>   Release tag to download from. Defaults to terminal-platform.lock.json.
  --archive <path>      Stage from a local runtime archive instead of GitHub.
  --ensure              Skip staging when the locked runtime is already present.
  --clean               Remove staged runtime files and keep resources/terminal-platform/.gitkeep.
  --help                Show this message.
`);
}

function parseArgs(argv) {
  const parsed = {
    archive: null,
    clean: false,
    ensure: false,
    help: false,
    platform: null,
    releaseTag: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--clean') {
      parsed.clean = true;
      continue;
    }
    if (arg === '--ensure') {
      parsed.ensure = true;
      continue;
    }
    if (arg === '--archive') {
      parsed.archive = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--platform') {
      parsed.platform = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--release-tag') {
      parsed.releaseTag = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    shell: false,
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function readLock() {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

function getDefaultPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (
    key === 'darwin-arm64' ||
    key === 'darwin-x64' ||
    key === 'linux-x64' ||
    key === 'win32-x64'
  ) {
    return key;
  }
  throw new Error(`No terminal-platform runtime asset is configured for ${key}`);
}

function getReleaseTag(lock, override) {
  const tag = override?.trim() || lock.releaseTag?.trim() || lock.sourceRef?.trim();
  if (!tag) {
    throw new Error('terminal-platform.lock.json does not define releaseTag or sourceRef');
  }
  return tag;
}

function getReleaseAssetUrl(lock, releaseTag, asset) {
  return getReleaseFileUrl(lock, releaseTag, asset.file);
}

function getReleaseFileUrl(lock, releaseTag, fileName) {
  return `https://github.com/${lock.releaseRepository}/releases/download/${releaseTag}/${encodeURIComponent(fileName)}`;
}

function cleanRuntimeDir() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') {
      continue;
    }
    fs.rmSync(path.join(runtimeDir, entry.name), { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStageLock(lockFilePath) {
  const waitDeadline = Date.now() + 120_000;
  let announcedWait = false;

  while (true) {
    try {
      return await fs.promises.open(lockFilePath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (!announcedWait) {
        process.stdout.write('Waiting for another terminal-platform runtime stage to finish...\n');
        announcedWait = true;
      }

      if (Date.now() >= waitDeadline) {
        throw new Error(`Timed out waiting for terminal-platform runtime stage lock: ${lockFilePath}`);
      }

      await sleep(750);
    }
  }
}

async function downloadFile(url, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const response = await fetch(url, {
    headers: {
      'user-agent': 'agent-teams-terminal-platform-stager',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download terminal-platform runtime asset: ${response.status} ${response.statusText}`
    );
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
}

function downloadReleaseFileWithGh(lock, releaseTag, fileName, destinationPath) {
  if (!process.env.GH_TOKEN) {
    return false;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const result = spawnSync(
    'gh',
    [
      'release',
      'download',
      releaseTag,
      '--repo',
      lock.releaseRepository,
      '--pattern',
      fileName,
      '--dir',
      path.dirname(destinationPath),
      '--clobber',
    ],
    {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    }
  );

  return result.status === 0 && fs.existsSync(destinationPath);
}

function downloadReleaseAssetWithGh(lock, releaseTag, asset, destinationPath) {
  return downloadReleaseFileWithGh(lock, releaseTag, asset.file, destinationPath);
}

function extractArchive(archivePath, extractDir, archiveKind) {
  fs.mkdirSync(extractDir, { recursive: true });

  if (archiveKind === 'tar.gz') {
    runOrThrow('tar', ['-xzf', archivePath, '-C', extractDir]);
    return;
  }

  if (archiveKind === 'zip') {
    if (process.platform === 'win32') {
      runOrThrow('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ]);
      return;
    }

    runOrThrow('unzip', ['-oq', archivePath, '-d', extractDir]);
    return;
  }

  throw new Error(`Unsupported terminal-platform archive kind: ${archiveKind}`);
}

function findRuntimePayloadDir(extractDir, asset) {
  const payloadDirName = asset.payloadDirName || 'terminal-platform';
  const packageDirName = asset.packageDirName || 'terminal-platform-node';
  const candidates = [path.join(extractDir, payloadDirName), extractDir];

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'VERSION')) &&
      fs.existsSync(path.join(candidate, asset.binaryName)) &&
      fs.existsSync(path.join(candidate, packageDirName, 'index.mjs')) &&
      fs.existsSync(path.join(candidate, packageDirName, 'native', 'manifest.json'))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `Extracted terminal-platform archive does not contain ${payloadDirName}/VERSION, ${asset.binaryName}, and ${packageDirName}/index.mjs`
  );
}

function verifyChecksum(archivePath, asset) {
  if (!asset.sha256) {
    return;
  }

  const actual = hashFile(archivePath);
  if (actual !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.file}. Expected ${asset.sha256}, got ${actual}`);
  }
}

function verifyStagedRuntime(lock, asset, platformKey) {
  const packageDirName = asset.packageDirName || 'terminal-platform-node';
  const versionPath = path.join(runtimeDir, 'VERSION');
  const binaryPath = path.join(runtimeDir, asset.binaryName);
  const packageEntryPath = path.join(runtimeDir, packageDirName, 'index.mjs');
  const nativeManifestPath = path.join(runtimeDir, packageDirName, 'native', 'manifest.json');

  if (!fs.existsSync(versionPath)) {
    throw new Error('Staged terminal-platform runtime is missing VERSION');
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Staged terminal-platform runtime is missing ${asset.binaryName}`);
  }
  if (!fs.existsSync(packageEntryPath)) {
    throw new Error(`Staged terminal-platform runtime is missing ${packageDirName}/index.mjs`);
  }
  if (!fs.existsSync(nativeManifestPath)) {
    throw new Error(
      `Staged terminal-platform runtime is missing ${packageDirName}/native/manifest.json`
    );
  }

  const versionText = fs.readFileSync(versionPath, 'utf8').trim();
  if (!versionText.includes(lock.version)) {
    throw new Error(
      `Staged terminal-platform version mismatch for ${platformKey}. Expected ${lock.version}, got ${versionText}`
    );
  }
}

function isStagedRuntimeValid(lock, asset, platformKey) {
  try {
    verifyStagedRuntime(lock, asset, platformKey);
    return true;
  } catch {
    return false;
  }
}

async function stageRuntime(options) {
  const lock = readLock();
  const platformKey = options.platform?.trim() || getDefaultPlatformKey();
  const lockedAsset = lock.assets?.[platformKey];
  if (!lockedAsset) {
    throw new Error(`terminal-platform.lock.json has no asset for ${platformKey}`);
  }

  if (options.ensure && isStagedRuntimeValid(lock, lockedAsset, platformKey)) {
    process.stdout.write(
      `Using staged terminal-platform runtime ${lock.version} for ${platformKey}\n`
    );
    return;
  }

  fs.mkdirSync(downloadRoot, { recursive: true });
  const stageLockPath = path.join(downloadRoot, `stage-${platformKey}.lock`);
  const lockHandle = options.ensure ? await acquireStageLock(stageLockPath) : null;

  try {
    if (options.ensure && lockHandle && isStagedRuntimeValid(lock, lockedAsset, platformKey)) {
      process.stdout.write(
        `Using staged terminal-platform runtime ${lock.version} for ${platformKey}\n`
      );
      return;
    }

    const releaseTag = getReleaseTag(lock, options.releaseTag);
    const workDir = path.join(downloadRoot, `stage-${platformKey}-${process.pid}-${Date.now()}`);
    const asset = options.archive
      ? lockedAsset
      : await resolveReleaseManifestAsset(lock, releaseTag, platformKey, lockedAsset, workDir);
    const archivePath = path.join(workDir, asset.file);
    const extractDir = path.join(workDir, 'extracted');

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });

    try {
      if (options.archive) {
        fs.copyFileSync(path.resolve(options.archive), archivePath);
      } else {
        const url = getReleaseAssetUrl(lock, releaseTag, asset);
        process.stdout.write(
          `Downloading ${asset.file} from ${lock.releaseRepository}@${releaseTag}\n`
        );
        if (!downloadReleaseAssetWithGh(lock, releaseTag, asset, archivePath)) {
          await downloadFile(url, archivePath);
        }
      }

      verifyChecksum(archivePath, asset);
      process.stdout.write(`Extracting ${asset.file}\n`);
      extractArchive(archivePath, extractDir, asset.archiveKind);

      const payloadDir = findRuntimePayloadDir(extractDir, asset);
      cleanRuntimeDir();
      fs.cpSync(payloadDir, runtimeDir, { recursive: true });
      if (process.platform !== 'win32' && platformKey !== 'win32-x64') {
        fs.chmodSync(path.join(runtimeDir, asset.binaryName), 0o755);
      }
      verifyStagedRuntime(lock, asset, platformKey);
      process.stdout.write(
        `Staged terminal-platform runtime ${lock.version} for ${platformKey}\n`
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    if (lockHandle) {
      await lockHandle.close();
      fs.rmSync(stageLockPath, { force: true });
    }
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function resolveReleaseManifestAsset(lock, releaseTag, platformKey, asset, workDir) {
  if (asset.sha256) {
    return asset;
  }

  const manifestFile = `terminal-platform-runtime-manifest-v${lock.version}.json`;
  const manifestPath = path.join(workDir, manifestFile);
  const manifestUrl = getReleaseFileUrl(lock, releaseTag, manifestFile);

  process.stdout.write(
    `Downloading ${manifestFile} from ${lock.releaseRepository}@${releaseTag}\n`
  );
  if (!downloadReleaseFileWithGh(lock, releaseTag, manifestFile, manifestPath)) {
    await downloadFile(manifestUrl, manifestPath);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== lock.version) {
    throw new Error(
      `terminal-platform manifest version mismatch. Expected ${lock.version}, got ${manifest.version}`
    );
  }

  const manifestAsset = manifest.assets?.[platformKey];
  if (!manifestAsset) {
    throw new Error(`terminal-platform manifest has no asset for ${platformKey}`);
  }
  if (manifestAsset.file !== asset.file) {
    throw new Error(
      `terminal-platform manifest asset mismatch for ${platformKey}. Expected ${asset.file}, got ${manifestAsset.file}`
    );
  }
  if (!manifestAsset.sha256) {
    throw new Error(`terminal-platform manifest asset ${asset.file} is missing sha256`);
  }

  return {
    ...asset,
    archiveKind: manifestAsset.archiveKind || asset.archiveKind,
    binaryName: manifestAsset.binaryName || asset.binaryName,
    packageDirName: manifestAsset.packageDirName || asset.packageDirName,
    payloadDirName: manifestAsset.payloadDirName || asset.payloadDirName,
    sha256: manifestAsset.sha256,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.clean) {
    cleanRuntimeDir();
    process.stdout.write('Cleaned resources/terminal-platform\n');
    return;
  }

  await stageRuntime(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
