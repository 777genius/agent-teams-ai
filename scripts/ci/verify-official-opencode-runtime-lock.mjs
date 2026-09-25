#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, 'opencode-hosted-runtime.lock.json');
const repository = 'anomalyco/opencode';
const version = '1.18.32';
const tag = `v${version}`;
const commit = '545f51d26cc39a907d2867492d498d9607ea5fa4';

// Reviewed upstream release assets. Changes to the root lock need an explicit update here.
const assets = {
  'darwin-arm64': [
    'opencode-darwin-arm64.zip',
    'fa643f93401c13508d8d513780e54ce9cc01203d501114be9b88d62408b8101f',
    'a3c45d4e1d6620b436851f1ef6b25c71befcf06a382e279a1eb1c2196424395e',
  ],
  'darwin-x64': [
    'opencode-darwin-x64.zip',
    'a24bf10499382f8855e19d2a081b8683e4ab99c7c2affb32dc89b17c8a00ccd6',
    '5c944e90c2b3ac6bf6c9425b40b670b9950a0d4a3c0e6775470b93afc6c3dd6e',
  ],
  'linux-arm64': [
    'opencode-linux-arm64.tar.gz',
    '568461b7d4d8c19865c97e9a1102e613049c6039d01fe772154de873c1865840',
    '7c6e67883fcb230b7d4cb1bfea821756ed8b320c1fb44e9c36c8e7fc8725826b',
  ],
  'linux-x64': [
    'opencode-linux-x64.tar.gz',
    '3046e0404fdc60fb80307e7a47824ba07477364178a4d09baa8548496dd6d43b',
    '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080',
  ],
  'win32-arm64': [
    'opencode-windows-arm64.zip',
    '5c1c21e85b694ac3fedccff22f934484c29273d5b5780eff006960304108e124',
    '8113bfe4b169e4f5422bad63e9720d01614cee526d7132c698e11495342de9f4',
  ],
  'win32-x64': [
    'opencode-windows-x64.zip',
    '1483c72d5adced825590a0ecf8cc18b3e87e535960a125dbf539d33bce135d0f',
    'cf664aa1da32b788f9b2699b84a9bb9be30b7e025693b90f9b85829d5fe4e252',
  ],
};

function fail(reason) {
  throw new Error(`official-opencode-runtime-lock-invalid:${reason}`);
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

if (process.argv.length > 3) fail('arguments');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (
  !hasExactKeys(lock, [
    'schemaVersion',
    'runtime',
    'version',
    'tag',
    'productionEligible',
    'source',
    'releaseRepository',
    'platforms',
  ]) ||
  lock.schemaVersion !== 3 ||
  lock.runtime !== 'opencode' ||
  lock.version !== version ||
  lock.tag !== tag ||
  lock.productionEligible !== true ||
  lock.releaseRepository !== repository
) {
  fail('release');
}
if (
  !hasExactKeys(lock.source, ['repository', 'commit']) ||
  lock.source.repository !== repository ||
  lock.source.commit !== commit
) {
  fail('source');
}
if (!hasExactKeys(lock.platforms, Object.keys(assets))) fail('platforms');

for (const [platform, [file, archiveSha256, binarySha256]] of Object.entries(assets)) {
  const asset = lock.platforms[platform];
  const archiveKind = file.endsWith('.tar.gz') ? 'tar.gz' : 'zip';
  const binaryName = platform.startsWith('win32-') ? 'opencode.exe' : 'opencode';
  if (
    !hasExactKeys(asset, [
      'status',
      'file',
      'archiveKind',
      'binaryName',
      'archiveSha256',
      'binarySha256',
      'assetUrl',
    ]) ||
    asset.status !== 'available' ||
    asset.file !== file ||
    asset.archiveKind !== archiveKind ||
    asset.binaryName !== binaryName ||
    asset.archiveSha256 !== archiveSha256 ||
    asset.binarySha256 !== binarySha256 ||
    asset.assetUrl !== `https://github.com/${repository}/releases/download/${tag}/${file}`
  ) {
    fail(`asset:${platform}`);
  }
}

process.stdout.write(`official-opencode-runtime-lock-ok:${tag}:${commit}:6\n`);
