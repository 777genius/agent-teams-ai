import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

interface NodeArtifact {
  archive: string;
  sha256: string;
}

interface NodeLock {
  schemaVersion: 1;
  nodeVersion: string;
  checksumSource: string;
  platforms: Record<string, NodeArtifact>;
}

export interface StagedNode {
  schemaVersion: 1;
  platform: string;
  version: string;
  archiveSha256: string;
  binarySha256: string;
  executable: string;
  source: string;
}

const repository = fileURLToPath(new URL('../../', import.meta.url));
const maximumArchiveBytes = 128 * 1024 * 1024;

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function acquire(url: string, destination: string, expectedDigest: string): Promise<void> {
  try {
    if ((await digest(destination)) !== expectedDigest)
      throw new Error('Cached Node checksum mismatch');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body)
    throw new Error(`Node download failed: HTTP ${response.status}`);
  const temporary = `${destination}.${randomUUID()}.partial`;
  const reader = response.body.getReader();
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield Buffer.from(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let received = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > maximumArchiveBytes ? new Error('Node archive exceeds limit') : null,
        chunk
      );
    },
  });
  try {
    await pipeline(
      Readable.from(chunks()),
      bound,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    );
    if ((await digest(temporary)) !== expectedDigest)
      throw new Error('Downloaded Node checksum mismatch');
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Extract one exact member after the caller verifies the selected archive digest. */
export function extractNodeArchiveMember(archivePath: string, destination: string, member: string): void {
  const archive = resolve(archivePath), name = basename(archive);
  if (!name || name.startsWith('-') || name.includes(':')) throw new Error('Invalid local Node archive name');
  let tar = 'tar';
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(systemRoot))
      throw new Error('Windows Node extraction requires an absolute SystemRoot');
    // The inbox BSD tar reads the pinned ZIP. Git's GNU tar on PATH does not.
    tar = win32.join(systemRoot, 'System32', 'tar.exe');
  }
  // Node opens Unicode paths with the native Windows API; inbox tar can lose
  // those characters in -f/-C arguments. Keep the selected archive as stdin.
  const archiveFd = openSync(archive, 'r');
  try {
    execFileSync(tar, [name.endsWith('.tar.gz') ? '-xzf' : '-xf', '-', member], {
      cwd: resolve(destination), timeout: 30_000, stdio: [archiveFd, 'pipe', 'pipe'],
    });
  } finally { closeSync(archiveFd); }
}

/** Build-time acquisition only. The installed app never downloads or resolves Node from PATH. */
export async function stageNode(
  platform = `${process.platform}-${process.arch}`,
  resourceRoot = join(repository, 'resources/legacy-agent-host'),
  cacheRoot = join(repository, '.legacy-host-download')
): Promise<StagedNode> {
  const lock = JSON.parse(
    await readFile(join(repository, 'legacy-host.lock.json'), 'utf8')
  ) as NodeLock;
  const artifact = lock.platforms[platform];
  if (lock.schemaVersion !== 1 || !artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Unsupported Node artifact profile');
  }
  const version = lock.nodeVersion;
  const folder = join(resourceRoot, 'node', `v${version}`, platform);
  const executable = platform.startsWith('win32-') ? 'node.exe' : 'node';
  try {
    const manifest = JSON.parse(
      await readFile(join(folder, 'manifest.json'), 'utf8')
    ) as StagedNode;
    if (
      manifest.version !== version ||
      manifest.platform !== platform ||
      manifest.archiveSha256 !== artifact.sha256 ||
      manifest.executable !== executable ||
      (await digest(join(folder, executable))) !== manifest.binarySha256
    ) {
      throw new Error('Existing staged Node differs from selected profile');
    }
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(cacheRoot, { recursive: true });
  const source = `https://nodejs.org/dist/v${version}/${artifact.archive}`;
  const archivePath = join(cacheRoot, artifact.archive);
  await acquire(source, archivePath, artifact.sha256);
  const staging = join(dirname(folder), `.stage-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const prefix = artifact.archive.replace(/\.(tar\.gz|zip)$/, '');
    const member = `${prefix}/${executable === 'node.exe' ? 'node.exe' : 'bin/node'}`;
    // Extract only the selected file from the pinned archive, never an arbitrary archive tree.
    extractNodeArchiveMember(archivePath, staging, member);
    const binary = join(staging, executable);
    await rename(join(staging, member), binary);
    await rm(join(staging, prefix), { recursive: true });
    await chmod(binary, 0o755);
    if (
      platform === `${process.platform}-${process.arch}` &&
      execFileSync(binary, ['--version'], { encoding: 'utf8', env: {}, timeout: 5_000 }).trim() !==
        `v${version}`
    ) {
      throw new Error('Staged Node version mismatch');
    }
    const manifest: StagedNode = {
      schemaVersion: 1,
      platform,
      version,
      archiveSha256: artifact.sha256,
      binarySha256: await digest(binary),
      executable,
      source,
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(staging, folder);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length > 0 && args[0] !== '--platform') || args.length === 1) {
    throw new Error('Usage: node scripts/legacy-agent-host/stage-node.ts [--platform OS-ARCH]');
  }
  process.stdout.write(`${JSON.stringify(await stageNode(args[1]))}\n`);
}
