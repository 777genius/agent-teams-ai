#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { formatGitHubReleaseDownloadError } from './lib/github-release-download-error.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runtimeLockPath = path.join(repoRoot, 'runtime.lock.json');
const runtimeDir = path.join(repoRoot, 'resources', 'runtime');
const downloadRoot = path.join(repoRoot, '.runtime-download');

function printUsage() {
  process.stdout.write(`Usage: node scripts/stage-runtime.mjs [options]

Options:
  --platform <key>      Runtime platform key. Defaults to the current platform.
  --release-tag <tag>   Release tag to download from. Defaults to runtime.lock.json.
  --clean               Remove staged runtime files and keep resources/runtime/.gitkeep.
  --help                Show this message.
`);
}

function parseArgs(argv) {
  const parsed = {
    platform: null,
    releaseTag: null,
    clean: false,
    help: false,
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
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function readRuntimeLock() {
  return JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));
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
  throw new Error(`No bundled runtime asset is configured for ${key}`);
}

function getReleaseTag(runtimeLock, override) {
  const tag = override?.trim() || runtimeLock.releaseTag?.trim() || runtimeLock.sourceRef?.trim();
  if (!tag) {
    throw new Error('runtime.lock.json does not define releaseTag or sourceRef');
  }
  return tag;
}

function getReleaseAssetUrl(runtimeLock, releaseTag, asset) {
  return `https://github.com/${runtimeLock.releaseRepository}/releases/download/${releaseTag}/${encodeURIComponent(asset.file)}`;
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

async function downloadFile(url, destinationPath, context = {}) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const response = await fetch(url, {
    headers: {
      'user-agent': 'agent-teams-runtime-stager',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(
      formatGitHubReleaseDownloadError({
        kind: 'runtime asset',
        response,
        url,
        lockPath: runtimeLockPath,
        notFoundHint:
          '404 usually means the runtime release or asset is missing, private, or inaccessible. Authenticate gh with access to the runtime repository or run from the release workflow with RUNTIME_BUILD_DISPATCH_TOKEN.',
        ...context,
      })
    );
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
}

function downloadReleaseAssetWithGh(runtimeLock, releaseTag, asset, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const result = spawnSync(
    'gh',
    [
      'release',
      'download',
      releaseTag,
      '--repo',
      runtimeLock.releaseRepository,
      '--pattern',
      asset.file,
      '--dir',
      path.dirname(destinationPath),
      '--clobber',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    }
  );

  return result.status === 0 && fs.existsSync(destinationPath);
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

  throw new Error(`Unsupported runtime archive kind: ${archiveKind}`);
}

function findRuntimePayloadDir(extractDir, binaryName) {
  const candidates = [path.join(extractDir, 'runtime'), extractDir];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'VERSION')) &&
      fs.existsSync(path.join(candidate, binaryName))
    ) {
      return candidate;
    }
  }
  throw new Error(`Extracted runtime archive does not contain runtime/VERSION and ${binaryName}`);
}

function verifyStagedRuntime(runtimeLock, asset, platformKey) {
  const versionPath = path.join(runtimeDir, 'VERSION');
  const binaryPath = path.join(runtimeDir, asset.binaryName);
  if (!fs.existsSync(versionPath)) {
    throw new Error('Staged runtime is missing resources/runtime/VERSION');
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Staged runtime is missing resources/runtime/${asset.binaryName}`);
  }

  const versionText = fs.readFileSync(versionPath, 'utf8').trim();
  if (!versionText.includes(runtimeLock.version)) {
    throw new Error(
      `Staged runtime version mismatch for ${platformKey}. Expected ${runtimeLock.version}, got ${versionText}`
    );
  }
}

async function stageRuntime(options) {
  const runtimeLock = readRuntimeLock();
  const platformKey = options.platform?.trim() || getDefaultPlatformKey();
  const asset = runtimeLock.assets?.[platformKey];
  if (!asset) {
    throw new Error(`runtime.lock.json has no asset for ${platformKey}`);
  }

  const releaseTag = getReleaseTag(runtimeLock, options.releaseTag);
  const workDir = path.join(downloadRoot, `stage-${platformKey}-${process.pid}-${Date.now()}`);
  const archivePath = path.join(workDir, asset.file);
  const extractDir = path.join(workDir, 'extracted');

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const url = getReleaseAssetUrl(runtimeLock, releaseTag, asset);
    process.stdout.write(
      `Downloading ${asset.file} from ${runtimeLock.releaseRepository}@${releaseTag}\n`
    );
    if (!downloadReleaseAssetWithGh(runtimeLock, releaseTag, asset, archivePath)) {
      await downloadFile(url, archivePath, {
        repository: runtimeLock.releaseRepository,
        releaseTag,
        assetName: asset.file,
      });
    }

    process.stdout.write(`Extracting ${asset.file}\n`);
    extractArchive(archivePath, extractDir, asset.archiveKind);

    const payloadDir = findRuntimePayloadDir(extractDir, asset.binaryName);
    cleanRuntimeDir();
    fs.cpSync(payloadDir, runtimeDir, { recursive: true });
    if (process.platform !== 'win32' && platformKey !== 'win32-x64') {
      fs.chmodSync(path.join(runtimeDir, asset.binaryName), 0o755);
    }
    verifyStagedRuntime(runtimeLock, asset, platformKey);
    process.stdout.write(`Staged runtime ${runtimeLock.version} for ${platformKey}\n`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.clean) {
    cleanRuntimeDir();
    process.stdout.write('Cleaned resources/runtime\n');
    return;
  }

  await stageRuntime(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
