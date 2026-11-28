import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { syncDirectory, syncFile } from './atomicPersistence.js';
import { sameArtifact, unlinkOwnedArtifact, writeGuardedTemp } from './mutationAuthority.js';
import type { ArtifactIdentity, MutationAuthorityOptions } from './mutationAuthority.js';

export interface AtomicCreateResult {
  dev: number;
  ino: number;
}

export async function atomicCreateAsync(
  targetPath: string,
  data: string | Buffer,
  options: {
    mode?: number;
    onPublished?: (identity: AtomicCreateResult) => void;
  } & MutationAuthorityOptions = {}
): Promise<AtomicCreateResult> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.review-create.${randomUUID()}.tmp`);
  let owned: ArtifactIdentity | undefined;

  try {
    options.assertCurrent?.();
    await fs.promises.mkdir(dir, { recursive: true });
    options.assertCurrent?.();
    if (options.assertCurrent)
      await writeGuardedTemp(tmpPath, data, options.mode, options, (identity) => {
        owned = identity;
      });
    else if (options.mode === undefined) {
      await fs.promises.writeFile(tmpPath, data, {
        ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
        flag: 'wx',
      });
    } else {
      await fs.promises.writeFile(tmpPath, data, {
        ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
        flag: 'wx',
        mode: options.mode,
      });
    }

    options.assertCurrent?.();
    await syncFile(tmpPath, true);
    const identity = await fs.promises.lstat(tmpPath);
    options.assertCurrent?.();
    if (owned && !sameArtifact(identity, owned))
      throw new Error('Atomic create staging identity changed');
    await fs.promises.link(tmpPath, targetPath);
    options.onPublished?.({ dev: identity.dev, ino: identity.ino });
    options.assertCurrent?.();
    try {
      if (options.assertCurrent) unlinkOwnedArtifact(tmpPath, owned, options);
      else await fs.promises.unlink(tmpPath);
    } catch {
      // The target is already a fully synced, atomically published hardlink. Report
      // terminal success instead of deleting it or making a lost IPC response
      // ambiguous. A later authorization pass removes this reserved sibling link.
    }
    options.assertCurrent?.();
    await syncDirectory(dir, true);
    options.assertCurrent?.();
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    if (options.assertCurrent) {
      try {
        unlinkOwnedArtifact(tmpPath, owned, options);
      } catch {
        /* Retain private evidence after revocation. */
      }
    } else await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, false);
}

export async function cleanupAtomicCreateTempLinks(targetPath: string): Promise<void> {
  const target = await fs.promises.lstat(targetPath);
  if (target.nlink <= 1) return;

  const dir = path.dirname(targetPath);
  const entries = await fs.promises.readdir(dir);
  for (const entry of entries) {
    if (!/^\.review-create\.[a-f0-9-]+\.tmp$/i.test(entry)) continue;
    const candidatePath = path.join(dir, entry);
    try {
      const candidate = await fs.promises.lstat(candidatePath);
      if (candidate.dev === target.dev && candidate.ino === target.ino) {
        await fs.promises.unlink(candidatePath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  await syncDirectoryBestEffort(dir);
}
