import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

interface TransactionManifest {
  version: number;
  id: string;
  kind: string;
  sourcePath: string;
  targetPath: string;
  expectedSha256: string;
  nextSha256: string | null;
  phase: string;
}

/** Accept only an exact transaction-owned preimage or postimage inode. */
export async function isOwnedReviewFileTransactionHardlink(targetPath: string): Promise<boolean> {
  const requestedPath = path.resolve(targetPath);
  const target = await lstatOrNull(requestedPath);
  if (
    !target ||
    target.isSymbolicLink() ||
    !target.isFile() ||
    target.nlink < 2 ||
    target.nlink > 3
  ) {
    return false;
  }

  const directory = path.dirname(requestedPath);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.review-txn-[a-f0-9]{16}-[a-f0-9-]{36}$/i.test(entry.name)) {
      continue;
    }
    const transactionDir = path.join(directory, entry.name);
    const manifestPath = path.join(transactionDir, 'manifest.json');
    const manifestStat = await lstatOrNull(manifestPath);
    if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) continue;
    let manifest: TransactionManifest;
    try {
      manifest = JSON.parse(
        await fs.promises.readFile(manifestPath, 'utf8')
      ) as TransactionManifest;
    } catch {
      continue;
    }
    if (
      !manifest ||
      manifest.version !== 1 ||
      !['replace', 'move', 'delete'].includes(manifest.kind) ||
      typeof manifest.targetPath !== 'string' ||
      !path.isAbsolute(manifest.targetPath) ||
      path.resolve(manifest.targetPath) !== manifest.targetPath ||
      path.dirname(manifest.targetPath) !== directory ||
      typeof manifest.sourcePath !== 'string' ||
      !path.isAbsolute(manifest.sourcePath) ||
      path.resolve(manifest.sourcePath) !== manifest.sourcePath ||
      typeof manifest.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(manifest.id) ||
      entry.name !== `.review-txn-${sha256(manifest.targetPath).slice(0, 16)}-${manifest.id}` ||
      typeof manifest.expectedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.expectedSha256)
    ) {
      continue;
    }
    const [exactTarget, after, before, detached] = await Promise.all([
      lstatOrNull(manifest.targetPath),
      lstatOrNull(path.join(transactionDir, 'after.tmp')),
      lstatOrNull(path.join(transactionDir, 'before.link')),
      lstatOrNull(path.join(transactionDir, 'detached')),
    ]);
    if (manifest.phase === 'prepared' || manifest.phase === 'detached') {
      if (
        manifest.sourcePath === requestedPath &&
        before &&
        sameInode(target, before) &&
        ((manifest.phase === 'prepared' && !detached && target.nlink === 2) ||
          (detached && sameInode(before, detached) && target.nlink === 3)) &&
        sha256(await fs.promises.readFile(requestedPath, 'utf8')) === manifest.expectedSha256
      ) {
        return true;
      }
      continue;
    }
    if (
      (manifest.phase !== 'detached' && manifest.phase !== 'published') ||
      manifest.kind === 'delete' ||
      manifest.targetPath.normalize('NFC').toLowerCase() !==
        requestedPath.normalize('NFC').toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(manifest.nextSha256 ?? '') ||
      target.nlink !== 2 ||
      !exactTarget ||
      !after ||
      !before ||
      !detached ||
      !sameInode(target, exactTarget) ||
      !sameInode(target, after) ||
      !sameInode(before, detached) ||
      sha256(await fs.promises.readFile(path.join(transactionDir, 'before.link'), 'utf8')) !==
        manifest.expectedSha256 ||
      sha256(await fs.promises.readFile(path.join(transactionDir, 'after.tmp'), 'utf8')) !==
        manifest.nextSha256
    ) {
      continue;
    }
    return true;
  }
  return false;
}
