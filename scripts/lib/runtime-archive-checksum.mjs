import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Streams a file through SHA-256 without buffering it entirely in memory.
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest
 */
export async function computeFileSha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Fails hard unless the downloaded runtime archive matches the sha256 pinned in
 * runtime.lock.json. This binds the bytes we execute/package to the exact bytes
 * the lock was reviewed against, so a mutated or re-uploaded public release
 * asset cannot slip in even though it still prints the expected --version.
 *
 * @param {string} archivePath  path to the downloaded archive on disk
 * @param {{ file?: string, sha256?: string }} asset  runtime.lock.json asset entry
 * @param {string} platformKey  e.g. "darwin-arm64" (for error messages)
 * @returns {Promise<string>} the verified lowercase hex digest
 */
export async function verifyRuntimeArchiveChecksum(archivePath, asset, platformKey) {
  const expected =
    typeof asset?.sha256 === 'string' ? asset.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(expected)) {
    throw new Error(
      `runtime.lock.json is missing a valid sha256 for ${platformKey}. ` +
        `Pin the published checksum before downloading the runtime archive.`
    );
  }

  const actual = (await computeFileSha256(archivePath)).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Runtime archive checksum mismatch for ${platformKey} (${asset?.file ?? archivePath}). ` +
        `Expected ${expected}, got ${actual}. Refusing to use an unverified runtime binary.`
    );
  }

  return actual;
}

export { SHA256_PATTERN as RUNTIME_ARCHIVE_SHA256_PATTERN };
