import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI acquisition only: stage-node.ts still verifies, extracts and admits these pinned bytes.
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v24.21.0') {
  throw new Error('This CI prefill requires macOS arm64 and Node v24.21.0');
}
if (process.argv.length !== 2) throw new Error('This CI prefill accepts no arguments');

const repository = fileURLToPath(new URL('../../', import.meta.url));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
const lock: unknown = JSON.parse(await readFile(join(repository, 'legacy-host.lock.json'), 'utf8'));
const artifact = record(lock) && record(lock.platforms) ? lock.platforms['darwin-arm64'] : undefined;
const archive = 'node-v24.21.0-darwin-arm64.tar.gz';
const sha256 = 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057';
if (
  !record(lock) || !record(artifact) ||
  lock.schemaVersion !== 1 ||
  lock.nodeVersion !== '24.21.0' ||
  artifact.archive !== archive ||
  artifact.sha256 !== sha256
) {
  throw new Error('The selected Node lock differs from this reviewed CI transport profile');
}
const maximumBytes = 128 * 1024 * 1024;
const source = `https://nodejs.org/download/release/v24.21.0/${archive}`;
const cache = join(repository, '.legacy-host-download');
await mkdir(cache, { mode: 0o700 }).catch((error: unknown) => {
  if (!hasCode(error, 'EEXIST')) throw error;
});
const cacheInfo = await lstat(cache);
if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink() || (await realpath(cache)) !== cache) {
  throw new Error('The Node cache must be a canonical directory, not a symlink');
}
const destination = join(cache, archive);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return false;
  }
}

async function verify(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error('The Node archive must be a bounded regular file');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error('The Node archive checksum differs from lock');
}

if (await exists(destination)) {
  await verify(destination); // A corrupt existing cache is refused, never repaired or retried.
  console.log(JSON.stringify({ nodePrefill: 'verified-cache', archive, sha256 }));
} else {
  const temporary = `${destination}.${randomUUID()}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  await handle.close();
  try {
    const result = spawnSync(
      'curl',
      [
        '--http1.1', '--fail', '--show-error', '--silent',
        '--connect-timeout', '15', '--max-time', '60',
        '--max-filesize', String(maximumBytes),
        '--write-out', 'http_version=%{http_version} http_code=%{http_code} size_download=%{size_download} time_total=%{time_total}',
        '--output', temporary,
        source,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 }
    );
    console.log(JSON.stringify({
      nodePrefill: 'single-download', archive, source, transport: 'http1.1',
      status: result.status, signal: result.signal, statistics: result.stdout?.trim(),
    }));
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`The single Node download failed: curl ${result.status}`);
    await verify(temporary);
    if (await exists(destination)) throw new Error('The Node cache changed during this acquisition');
    await rename(temporary, destination);
    console.log(JSON.stringify({ nodePrefill: 'verified-download', archive, source, sha256 }));
  } finally {
    await rm(temporary, { force: true });
  }
}
