#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(repoRoot, 'resources', 'git');
const lock = JSON.parse(await readFile(path.join(repoRoot, 'managed-git.lock.json'), 'utf8'));

export function gitExecutable(platform, root) {
  return path.join(root, platform.startsWith('win32') ? 'cmd/git.exe' : 'bin/git');
}

export function validateArchiveEntries(entries) {
  for (const name of entries) {
    if (!name || name === '.' || name === './') continue;
    const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..') ||
      normalized.includes('\0')
    ) throw new Error(`Unsafe Git archive member: ${name}`);
  }
}

function tar(args, maxBuffer = 128 * 1024 * 1024) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer, timeout: 180_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Git archive extraction failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

async function hashFile(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'agent-teams-managed-git-stager', accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the pinned Git archive (HTTP ${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(destination));
}

async function validateLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const target = await import('node:fs/promises').then((fs) => fs.realpath(candidate));
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Git archive symlink leaves its staging directory: ${candidate}`);
        }
      } else if (metadata.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
}

export async function stageManagedGit(platform, { root = stagingRoot } = {}) {
  const asset = lock.assets?.[platform];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`No pinned Git runtime for target ${platform}`);
  }
  const markerPath = path.join(root, 'MANAGED_GIT.json');
  const marker = await readFile(markerPath, 'utf8').then(JSON.parse).catch(() => null);
  if (marker?.platform === platform && marker?.sha256 === asset.sha256) {
    try {
      await access(gitExecutable(platform, root));
      return root;
    } catch {
      // Partial staging must be repaired rather than trusted.
    }
  }

  const scratch = await mkdtemp(path.join(repoRoot, 'resources', '.managed-git-staging-'));
  const archive = path.join(scratch, 'archive.tar.gz');
  const unpacked = path.join(scratch, 'git');
  const url = `https://github.com/${lock.repository}/releases/download/${lock.tag}/${asset.filename}`;
  try {
    await downloadArchive(url, archive);
    const actual = await hashFile(archive);
    if (actual !== asset.sha256) throw new Error(`Git archive SHA-256 mismatch: ${platform}`);
    const entries = tar(['-tzf', archive]).split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries);
    await (await import('node:fs/promises')).mkdir(unpacked);
    tar(['-xzf', archive, '-C', unpacked]);
    await validateLinks(unpacked);
    await access(gitExecutable(platform, unpacked));
    await writeFile(path.join(unpacked, 'MANAGED_GIT.json'), JSON.stringify({
      platform,
      tag: lock.tag,
      sha256: asset.sha256,
    }) + '\n');
    const previous = `${root}.previous`;
    await rm(previous, { recursive: true, force: true });
    await rename(root, previous).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    try {
      await rename(unpacked, root);
    } catch (error) {
      await rename(previous, root).catch(() => undefined);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    console.log(`[managed-git] staged ${platform} from ${lock.tag} (verified SHA-256)`);
    return root;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flagIndex = process.argv.indexOf('--platform');
  const platform = flagIndex >= 0 ? process.argv[flagIndex + 1] : `${process.platform}-${process.arch}`;
  await stageManagedGit(platform);
}
