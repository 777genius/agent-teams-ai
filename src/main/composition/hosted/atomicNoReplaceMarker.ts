import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileHandle } from 'node:fs/promises';

export interface AtomicNoReplaceMarkerHooks {
  afterTemporarySynced?(path: string): void | Promise<void>;
  afterLinked?(path: string): void | Promise<void>;
  afterParentSynced?(path: string): void | Promise<void>;
  afterTemporaryUnlinked?(path: string): void | Promise<void>;
}

export interface AtomicNoReplaceMarkerOptions {
  readonly parentPath: string;
  readonly parentHandle: FileHandle;
  readonly finalName: string;
  readonly payload: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly existing: 'accept-identical' | 'reject';
  readonly hooks?: AtomicNoReplaceMarkerHooks;
}

function assertMarker(stat: BigIntStats, options: AtomicNoReplaceMarkerOptions): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(options.expectedUid) ||
    stat.gid !== BigInt(options.expectedGid) ||
    Number(stat.mode & 0o777n) !== 0o600 ||
    stat.size !== BigInt(Buffer.byteLength(options.payload)) ||
    (stat.nlink !== 1n && stat.nlink !== 2n)
  ) {
    throw new Error('hosted-atomic-marker-invalid');
  }
}

async function readExact(handle: FileHandle, options: AtomicNoReplaceMarkerOptions): Promise<void> {
  const before = await handle.stat({ bigint: true });
  assertMarker(before, options);
  const expected = Buffer.from(options.payload, 'utf8');
  const buffer = Buffer.alloc(expected.byteLength + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
  const after = await handle.stat({ bigint: true });
  assertMarker(after, options);
  if (
    bytesRead !== expected.byteLength ||
    !buffer.subarray(0, bytesRead).equals(expected) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error('hosted-atomic-marker-invalid');
  }
}

async function openMarker(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function recoverPending(
  temporaryPath: string,
  finalPath: string,
  options: AtomicNoReplaceMarkerOptions
): Promise<'absent' | 'published'> {
  const temporary = await openMarker(temporaryPath);
  if (temporary === null) return 'absent';
  try {
    await readExact(temporary, options);
    const temporaryStat = await temporary.stat({ bigint: true });
    const final = await openMarker(finalPath);
    if (final === null) {
      if (temporaryStat.nlink !== 1n) throw new Error('hosted-atomic-marker-invalid');
      await unlink(temporaryPath);
      await options.parentHandle.sync();
      return 'absent';
    }
    try {
      await readExact(final, options);
      const finalStat = await final.stat({ bigint: true });
      if (
        temporaryStat.nlink !== 2n ||
        finalStat.nlink !== 2n ||
        temporaryStat.dev !== finalStat.dev ||
        temporaryStat.ino !== finalStat.ino
      ) {
        throw new Error('hosted-atomic-marker-invalid');
      }
      await options.parentHandle.sync();
      await unlink(temporaryPath);
      await options.parentHandle.sync();
      return 'published';
    } finally {
      await final.close();
    }
  } finally {
    await temporary.close();
  }
}

function markerPaths(options: AtomicNoReplaceMarkerOptions): {
  readonly temporaryPath: string;
  readonly finalPath: string;
} {
  const digest = createHash('sha256')
    .update(`${options.finalName}\u0000${options.payload}`, 'utf8')
    .digest('hex');
  return Object.freeze({
    temporaryPath: join(options.parentPath, `.pending-${digest}`),
    finalPath: join(options.parentPath, options.finalName),
  });
}

export async function recoverAtomicNoReplaceMarker(
  options: AtomicNoReplaceMarkerOptions
): Promise<'absent' | 'published'> {
  const paths = markerPaths(options);
  return recoverPending(paths.temporaryPath, paths.finalPath, options);
}

/** Same-directory fsync-backed publication. The final name is never visible with partial bytes. */
export async function publishAtomicNoReplaceMarker(
  options: AtomicNoReplaceMarkerOptions
): Promise<void> {
  if (
    !/^[A-Za-z0-9.][A-Za-z0-9._-]{0,191}$/u.test(options.finalName) ||
    options.finalName.startsWith('.pending-') ||
    Buffer.byteLength(options.payload) < 1 ||
    Buffer.byteLength(options.payload) > 8_192
  ) {
    throw new TypeError('hosted-atomic-marker-options-invalid');
  }
  const { temporaryPath, finalPath } = markerPaths(options);
  const recovered = await recoverPending(temporaryPath, finalPath, options);
  if (recovered === 'published') {
    if (options.existing === 'reject') throw new Error('hosted-atomic-marker-exists');
    return;
  }
  const existing = await openMarker(finalPath);
  if (existing !== null) {
    try {
      await readExact(existing, options);
    } finally {
      await existing.close();
    }
    if (options.existing === 'reject') throw new Error('hosted-atomic-marker-exists');
    return;
  }

  const temporary = await open(
    temporaryPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const bytes = Buffer.from(options.payload, 'utf8');
    const { bytesWritten } = await temporary.write(bytes, 0, bytes.byteLength, 0);
    if (bytesWritten !== bytes.byteLength) throw new Error('hosted-atomic-marker-short-write');
    await temporary.sync();
    await readExact(temporary, options);
    await options.hooks?.afterTemporarySynced?.(temporaryPath);
    await link(temporaryPath, finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('hosted-atomic-marker-exists');
      throw error;
    });
    await options.hooks?.afterLinked?.(finalPath);
    await options.parentHandle.sync();
    await options.hooks?.afterParentSynced?.(finalPath);
    const final = await openMarker(finalPath);
    if (final === null) throw new Error('hosted-atomic-marker-lost');
    try {
      await readExact(final, options);
      const [temporaryStat, finalStat] = await Promise.all([
        temporary.stat({ bigint: true }),
        final.stat({ bigint: true }),
      ]);
      if (
        temporaryStat.nlink !== 2n ||
        finalStat.nlink !== 2n ||
        temporaryStat.dev !== finalStat.dev ||
        temporaryStat.ino !== finalStat.ino
      ) {
        throw new Error('hosted-atomic-marker-invalid');
      }
    } finally {
      await final.close();
    }
    await unlink(temporaryPath);
    await options.hooks?.afterTemporaryUnlinked?.(temporaryPath);
    await options.parentHandle.sync();
  } catch (error) {
    // Retain a published two-link temp for deterministic recovery. Only an unpublished one-link
    // temp is safe to remove here.
    const stat = await lstat(temporaryPath, { bigint: true }).catch(() => null);
    if (stat?.nlink === 1n) {
      await unlink(temporaryPath).catch(() => undefined);
      await options.parentHandle.sync().catch(() => undefined);
    }
    throw error;
  } finally {
    await temporary.close();
  }
}
