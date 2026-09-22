#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isSafeArchiveBinaryPath(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(value) &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

const [manifestInput, platform] = process.argv.slice(2);
if (!manifestInput || !/^(?:darwin|linux|win32)-(?:arm64|x64)$/u.test(platform ?? '')) {
  throw new Error('usage: verify-hosted-opencode-runtime-materialization <release-manifest> <platform>');
}

const manifestPath = resolve(manifestInput);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'opencode-hosted-runtime.lock.json'), 'utf8'));
const candidatePlatform = platform.replace(/^win32-/u, 'windows-');
const asset = manifest.assets?.find((value) => `${value.os}-${value.arch}` === candidatePlatform);
const locked = lock.platforms?.[platform];
if (asset && !isSafeArchiveBinaryPath(asset.binaryPath)) {
  throw new Error('hosted-opencode-materialization-unsafe-binary-path');
}
if (
  !asset ||
  locked?.status !== 'available' ||
  lock.releaseRepository !== manifest.workflow?.repository ||
  lock.source?.commit !== manifest.release?.sourceCommit ||
  locked.file !== asset.archive ||
  locked.binaryName !== basename(asset.binaryPath) ||
  locked.archiveSha256 !== asset.archiveSha256 ||
  locked.binarySha256 !== asset.binarySha256
) {
  throw new Error('hosted-opencode-materialization-authority-mismatch');
}

const archivePath = resolve(dirname(manifestPath), asset.archive);
const archiveHash = createHash('sha256');
for await (const chunk of createReadStream(archivePath)) archiveHash.update(chunk);
if (archiveHash.digest('hex') !== asset.archiveSha256) {
  throw new Error('hosted-opencode-materialization-archive-mismatch');
}
const archiveKind = asset.archive.endsWith('.tar.gz') ? 'tar.gz' : 'zip';
const { stdout } = await run(
  archiveKind === 'tar.gz' ? '/usr/bin/tar' : '/usr/bin/unzip',
  archiveKind === 'tar.gz'
    ? ['-xOzf', archivePath, '--', asset.binaryPath]
    : ['-p', archivePath, asset.binaryPath],
  { encoding: 'buffer', maxBuffer: Math.max(asset.binarySize + 1024, 256 * 1024 * 1024) }
);
const binarySha256 = createHash('sha256').update(stdout).digest('hex');
if (binarySha256 !== asset.binarySha256) {
  throw new Error('hosted-opencode-materialization-binary-mismatch');
}
process.stdout.write(`${JSON.stringify({
  verified: true,
  authorityManifestSha256: createHash('sha256')
    .update(await readFile(manifestPath))
    .digest('hex'),
  repository: manifest.workflow.repository,
  sourceCommit: manifest.release.sourceCommit,
  platform,
  archiveSha256: asset.archiveSha256,
  binarySha256,
})}\n`);
