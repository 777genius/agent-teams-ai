import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const RENAME_MAX_ATTEMPTS = 20;
const RENAME_RETRY_BASE_DELAY_MS = 40;
const RENAME_RETRY_MAX_DELAY_MS = 250;
const RENAME_RETRY_JITTER_MS = 25;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface AtomicWriteOptions {
  mode?: number;
  /** Existing callers keep best-effort fsync; review mutations opt into strict durability. */
  durability?: 'best-effort' | 'strict';
  /** Persist the directory entry after publish when the caller needs crash durability. */
  syncDirectory?: boolean;
  /**
   * Runs after the temporary file is complete and synced, immediately before every
   * publish attempt (including Windows retries).
   * Callers can use this to repeat a compare-and-swap guard without exposing a
   * partially-written target.
   */
  beforeCommit?: () => Promise<void>;
}

export interface AtomicCreateResult {
  dev: number;
  ino: number;
}

export interface DurablePathIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type AtomicPathRemovalResult = 'deleted' | 'missing' | 'changed';

export interface DurablePathRemovalProofHooks {
  /**
   * Stable, transaction-owned sibling path used to resume an exact detached
   * removal after a process restart.
   */
  detachedPath: string;
  onDetachedValidated: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
  onRemovalDurable: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
}

export interface ExpectedTextFileIdentity {
  dev: number;
  ino: number;
  mode: number;
}

export type ReviewFileTransactionKind = 'replace' | 'delete' | 'move';

export interface ReviewFileTransactionDescriptor {
  id: string;
  kind: ReviewFileTransactionKind;
  sourcePath: string;
  targetPath: string;
  expectedContent: string;
  nextContent: string | null;
}

interface ReviewFileTransactionPaths {
  directoryPath: string;
  manifestPath: string;
  beforePath: string;
  detachedPath: string;
  afterPath: string;
}

interface ReviewFileTransactionManifest {
  version: 1;
  id: string;
  kind: ReviewFileTransactionKind;
  sourcePath: string;
  targetPath: string;
  expectedSha256: string;
  nextSha256: string | null;
  phase: 'prepared' | 'detached' | 'published';
}

function hashReviewTransactionPart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getReviewTransactionTargetKey(targetPath: string): string {
  return hashReviewTransactionPart(path.resolve(targetPath)).slice(0, 16);
}

function assertReviewTransactionId(id: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid review file transaction id');
}

function getReviewFileTransactionPaths(targetPath: string, id: string): ReviewFileTransactionPaths {
  assertReviewTransactionId(id);
  const directoryPath = path.join(
    path.dirname(path.resolve(targetPath)),
    `.review-txn-${getReviewTransactionTargetKey(targetPath)}-${id}`
  );
  return {
    directoryPath,
    manifestPath: path.join(directoryPath, 'manifest.json'),
    beforePath: path.join(directoryPath, 'before.link'),
    detachedPath: path.join(directoryPath, 'detached'),
    afterPath: path.join(directoryPath, 'after.tmp'),
  };
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

function isSameFileIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

export function getDurablePathIdentity(
  stats: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs'>
): DurablePathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

export function isSameDurablePathIdentity(
  left: DurablePathIdentity,
  right: DurablePathIdentity
): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

async function assertRegularTextArtifact(
  artifactPath: string,
  expectedContent: string,
  expectedIdentity?: Pick<ExpectedTextFileIdentity, 'dev' | 'ino'>
): Promise<fs.Stats> {
  const handle = await fs.promises.open(artifactPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('Review file transaction artifact is not a regular file');
    }
    if (expectedIdentity && !isSameFileIdentity(stats, expectedIdentity)) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
    const content = await handle.readFile('utf8');
    if (content !== expectedContent) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
    return stats;
  } finally {
    await handle.close();
  }
}

async function restoreDetachedPathNoClobber(
  detachedPath: string,
  targetPath: string
): Promise<boolean> {
  try {
    await fs.promises.link(detachedPath, targetPath);
    await fs.promises.unlink(detachedPath);
    await syncDirectoryBestEffort(path.dirname(targetPath));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    // Preserve both the externally-created target and the detached file. The
    // caller reports a conflict, and no version is destroyed.
    return false;
  }
}

async function publishHardlinkNoClobber(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.promises.link(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const [source, target] = await Promise.all([
      fs.promises.lstat(sourcePath),
      fs.promises.lstat(targetPath),
    ]);
    if (!isSameFileIdentity(source, target)) throw error;
  }
  await syncDirectoryBestEffort(path.dirname(targetPath));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getRenameRetryDelayMs(attempt: number): number {
  const backoff = Math.min(RENAME_RETRY_BASE_DELAY_MS * attempt, RENAME_RETRY_MAX_DELAY_MS);
  return backoff + Math.floor(Math.random() * (RENAME_RETRY_JITTER_MS + 1));
}

async function renameWithRetry(
  src: string,
  dest: string,
  beforeAttempt?: () => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    await beforeAttempt?.();
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_RENAME_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS) {
        await sleep(getRenameRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

function renameWithRetrySync(src: string, dest: string): void {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_RENAME_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS) {
        sleepSync(getRenameRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

export async function renamePathWithRetry(
  src: string,
  dest: string,
  options: { syncDirectories?: boolean; durability?: 'best-effort' | 'strict' } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      if (options.syncDirectories) {
        await syncRenamedDirectories(src, dest, options.durability === 'strict');
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_RENAME_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS) {
        await sleep(getRenameRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

export function renamePathWithRetrySync(src: string, dest: string): void {
  renameWithRetrySync(src, dest);
}

export function atomicWriteSync(
  targetPath: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (options.mode === undefined) {
      fs.writeFileSync(tmpPath, data, typeof data === 'string' ? 'utf8' : undefined);
    } else {
      fs.writeFileSync(tmpPath, data, {
        ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
        mode: options.mode,
      });
    }
    renameWithRetrySync(tmpPath, targetPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Async atomic write: write tmp file then rename over target.
 * Uses best-effort fsync and bounded Windows transient rename retries for safety.
 */
export async function atomicWriteAsync(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, data, {
      ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });

    await syncFile(tmpPath, options.durability === 'strict');
    await renameWithRetry(tmpPath, targetPath, options.beforeCommit);
    if (options.syncDirectory) {
      await syncDirectory(dir, options.durability === 'strict');
    }
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Publish a fully-written new file without ever overwriting a concurrently-created target.
 * A hard-link publish is atomic on the same filesystem. If the process stops between link
 * and temporary-name cleanup, the target still contains the complete synced payload.
 */
export async function atomicCreateAsync(
  targetPath: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): Promise<AtomicCreateResult> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.review-create.${randomUUID()}.tmp`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    if (options.mode === undefined) {
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

    await syncFile(tmpPath, true);
    const identity = await fs.promises.lstat(tmpPath);
    await fs.promises.link(tmpPath, targetPath);
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // The target is already a fully synced, atomically published hardlink. Report
      // terminal success instead of deleting it or making a lost IPC response
      // ambiguous. A later authorization pass removes this reserved sibling link.
    }
    await syncDirectory(dir, true);
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Replace an existing regular file only if the inode and contents that were
 * observed by the caller are still current. The observed pathname is detached
 * before comparison, and the new file is published with a no-clobber hardlink.
 * A concurrently published replacement therefore cannot be overwritten in the
 * compare/commit gap.
 */
export async function atomicReplaceFileIfUnchangedAsync(
  targetPath: string,
  data: string | Buffer,
  expected: {
    identity: DurablePathIdentity;
    content: string | Buffer;
  },
  options: { mode?: number } = {}
): Promise<AtomicCreateResult | null> {
  const dir = path.dirname(targetPath);
  const transactionId = randomUUID();
  const stagedPath = path.join(dir, `.compare-replace.${transactionId}.tmp`);
  const detachedPath = path.join(dir, `.compare-replace.${transactionId}.before`);
  let targetDetached = false;

  const restoreDetachedNoClobber = async (): Promise<void> => {
    try {
      await fs.promises.link(detachedPath, targetPath);
      await fs.promises.unlink(detachedPath);
      targetDetached = false;
      await syncDirectory(dir, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The concurrently published target wins. Retain the detached artifact
      // under its transaction name rather than destroying either version.
    }
  };

  try {
    await fs.promises.writeFile(stagedPath, data, {
      ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await syncFile(stagedPath, true);

    try {
      await fs.promises.rename(targetPath, detachedPath);
      targetDetached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const detachedHandle = await fs.promises.open(detachedPath, 'r');
    let detachedMatches = false;
    try {
      const detachedStats = await detachedHandle.stat();
      const detachedContent = await detachedHandle.readFile(
        typeof expected.content === 'string' ? 'utf8' : undefined
      );
      const contentMatches =
        typeof expected.content === 'string'
          ? detachedContent === expected.content
          : Buffer.isBuffer(detachedContent) && detachedContent.equals(expected.content);
      detachedMatches =
        detachedStats.isFile() &&
        isSameDurablePathIdentity(getDurablePathIdentity(detachedStats), expected.identity) &&
        contentMatches;
    } finally {
      await detachedHandle.close();
    }

    if (!detachedMatches) {
      await restoreDetachedNoClobber();
      return null;
    }

    const stagedStats = await fs.promises.lstat(stagedPath);
    try {
      await fs.promises.link(stagedPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A replacement was published after the comparison. It owns the target.
      await fs.promises.unlink(detachedPath);
      targetDetached = false;
      await syncDirectory(dir, true);
      return null;
    }
    await fs.promises.unlink(stagedPath);
    await fs.promises.unlink(detachedPath);
    targetDetached = false;
    await syncDirectory(dir, true);
    return { dev: stagedStats.dev, ino: stagedStats.ino };
  } finally {
    await fs.promises.unlink(stagedPath).catch(() => undefined);
    if (targetDetached) {
      await restoreDetachedNoClobber().catch(() => undefined);
    }
  }
}

/**
 * Atomically detach a path from its public name, validate the exact detached
 * object, and only then remove it. Anything published at the original name
 * after detachment is outside the destructive operation and survives.
 */
export async function removePathWithIdentityFenceAsync(
  targetPath: string,
  options: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    validateDetached?: (detachedPath: string, identity: DurablePathIdentity) => Promise<boolean>;
    durability?: 'best-effort' | 'strict';
    /**
     * Route writes which still use the public directory name into a durable
     * reservation while the detached object is validated and removed.
     */
    reservePublicDirectory?: boolean;
    proofHooks?: DurablePathRemovalProofHooks;
  } = {}
): Promise<AtomicPathRemovalResult> {
  const dir = path.dirname(targetPath);
  const detachedPath =
    options.proofHooks?.detachedPath ??
    path.join(dir, `.${path.basename(targetPath)}.deleting.${randomUUID()}`);
  const removalOptions = {
    ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
  };
  let detached = false;
  let publicReservationPath: string | null = null;
  let publicReservationPublished = false;
  let publicReservationIdentity: DurablePathIdentity | null = null;

  const copyReservationEntriesNoClobber = async (
    sourceDirectory: string,
    destinationDirectory: string
  ): Promise<void> => {
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      if (entry.isDirectory()) {
        try {
          await fs.promises.mkdir(destinationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const destinationStats = await fs.promises.lstat(destinationPath);
          if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) continue;
        }
        await copyReservationEntriesNoClobber(sourcePath, destinationPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(sourcePath);
        try {
          await fs.promises.symlink(linkTarget, destinationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      try {
        await fs.promises.link(sourcePath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  };

  const settlePublicReservation = async (): Promise<void> => {
    if (!publicReservationPath) return;
    const reservationPath = publicReservationPath;

    // rmdir is deliberately non-recursive: a write racing the close turns an
    // empty reservation into ENOTEMPTY instead of being deleted.
    try {
      await fs.promises.rmdir(reservationPath);
      publicReservationPath = null;
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        publicReservationPath = null;
        return;
      }
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }

    try {
      await fs.promises.mkdir(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A new public object already won. Keep the reservation as a durable,
      // uniquely named recovery copy rather than touching that replacement.
      return;
    }

    // The public directory was claimed with mkdir (no clobber). Publish every
    // captured entry with no-clobber links/directories; never unlink the
    // reservation copy because another writer may still hold it open.
    await copyReservationEntriesNoClobber(reservationPath, targetPath);
    await syncDirectory(targetPath, options.durability === 'strict');
  };

  const closePublicReservation = async (): Promise<void> => {
    if (publicReservationPublished && publicReservationIdentity) {
      const expectedReservationIdentity = publicReservationIdentity;
      // Detach first, then validate and remove the uniquely named detached
      // symlink. A replacement published at the public name before cleanup is
      // restored unchanged; one published during validation is never targeted.
      await removePathWithIdentityFenceAsync(targetPath, {
        ...removalOptions,
        durability: options.durability,
        validateDetached: async (reservationDetachedPath, identity) => {
          if (
            !isSameDurablePathIdentity(identity, expectedReservationIdentity) ||
            identity.birthtimeMs !== expectedReservationIdentity.birthtimeMs
          ) {
            return false;
          }
          const detachedStats = await fs.promises.lstat(reservationDetachedPath);
          return detachedStats.isSymbolicLink();
        },
      });
      publicReservationPublished = false;
      publicReservationIdentity = null;
    }
    await settlePublicReservation();
  };

  const restoreDetached = async (): Promise<boolean> => {
    try {
      await fs.promises.lstat(targetPath);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.promises.rename(detachedPath, targetPath);
      detached = false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  try {
    if (options.proofHooks) {
      let resumedStats: fs.Stats | null = null;
      try {
        resumedStats = await fs.promises.lstat(detachedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (resumedStats) {
        const resumedIdentity = getDurablePathIdentity(resumedStats);
        if (
          options.validateDetached &&
          !(await options.validateDetached(detachedPath, resumedIdentity))
        ) {
          return 'changed';
        }
        await options.proofHooks.onDetachedValidated(detachedPath, resumedIdentity);
        await fs.promises.rm(detachedPath, removalOptions);
        await syncDirectory(dir, options.durability === 'strict');
        await options.proofHooks.onRemovalDurable(detachedPath, resumedIdentity);
        return 'deleted';
      }
    }

    try {
      await fs.promises.rename(targetPath, detachedPath);
      detached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }

    const stats = await fs.promises.lstat(detachedPath);
    const identity = getDurablePathIdentity(stats);
    if (options.reservePublicDirectory && stats.isDirectory()) {
      publicReservationPath = path.join(
        dir,
        `.${path.basename(targetPath)}.replacement.${randomUUID()}`
      );
      await fs.promises.mkdir(publicReservationPath);
      try {
        await fs.promises.symlink(publicReservationPath, targetPath, 'junction');
        publicReservationIdentity = getDurablePathIdentity(await fs.promises.lstat(targetPath));
        publicReservationPublished = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await settlePublicReservation();
      }
    }

    if (options.validateDetached && !(await options.validateDetached(detachedPath, identity))) {
      await closePublicReservation();
      await restoreDetached();
      return 'changed';
    }

    await closePublicReservation();
    await options.proofHooks?.onDetachedValidated(detachedPath, identity);
    await fs.promises.rm(detachedPath, removalOptions);
    detached = false;
    await syncDirectory(dir, options.durability === 'strict');
    await options.proofHooks?.onRemovalDurable(detachedPath, identity);
    return 'deleted';
  } catch (error) {
    await closePublicReservation().catch(() => undefined);
    if (detached) await restoreDetached().catch(() => undefined);
    throw error;
  }
}

function buildReviewFileTransactionManifest(
  transaction: ReviewFileTransactionDescriptor,
  phase: ReviewFileTransactionManifest['phase']
): ReviewFileTransactionManifest {
  return {
    version: 1,
    id: transaction.id,
    kind: transaction.kind,
    sourcePath: path.resolve(transaction.sourcePath),
    targetPath: path.resolve(transaction.targetPath),
    expectedSha256: hashReviewTransactionPart(transaction.expectedContent),
    nextSha256:
      transaction.nextContent === null ? null : hashReviewTransactionPart(transaction.nextContent),
    phase,
  };
}

function assertValidReviewFileTransactionManifest(
  value: unknown
): asserts value is ReviewFileTransactionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review file transaction manifest');
  }
  const manifest = value as Partial<ReviewFileTransactionManifest>;
  if (
    manifest.version !== 1 ||
    !manifest.id ||
    !['replace', 'delete', 'move'].includes(String(manifest.kind)) ||
    typeof manifest.sourcePath !== 'string' ||
    !path.isAbsolute(manifest.sourcePath) ||
    typeof manifest.targetPath !== 'string' ||
    !path.isAbsolute(manifest.targetPath) ||
    typeof manifest.expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.expectedSha256) ||
    (manifest.nextSha256 !== null &&
      (typeof manifest.nextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.nextSha256))) ||
    !['prepared', 'detached', 'published'].includes(String(manifest.phase))
  ) {
    throw new Error('Invalid review file transaction manifest');
  }
  assertReviewTransactionId(manifest.id);
}

async function readReviewFileTransactionManifest(
  transaction: Pick<ReviewFileTransactionDescriptor, 'id' | 'targetPath'>
): Promise<ReviewFileTransactionManifest> {
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  const handle = await fs.promises.open(paths.manifestPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Invalid review file transaction manifest');
    const raw = JSON.parse(await handle.readFile('utf8')) as unknown;
    assertValidReviewFileTransactionManifest(raw);
    return raw;
  } finally {
    await handle.close();
  }
}

async function writeReviewFileTransactionManifest(
  transaction: ReviewFileTransactionDescriptor,
  phase: ReviewFileTransactionManifest['phase']
): Promise<void> {
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  await atomicWriteAsync(
    paths.manifestPath,
    `${JSON.stringify(buildReviewFileTransactionManifest(transaction, phase), null, 2)}\n`,
    { mode: 0o600, durability: 'strict', syncDirectory: true }
  );
}

function assertManifestMatchesTransaction(
  manifest: ReviewFileTransactionManifest,
  transaction: ReviewFileTransactionDescriptor
): void {
  const expected = buildReviewFileTransactionManifest(transaction, manifest.phase);
  if (
    manifest.id !== expected.id ||
    manifest.kind !== expected.kind ||
    manifest.sourcePath !== expected.sourcePath ||
    manifest.targetPath !== expected.targetPath ||
    manifest.expectedSha256 !== expected.expectedSha256 ||
    manifest.nextSha256 !== expected.nextSha256
  ) {
    throw new Error('Review file transaction does not match the requested mutation');
  }
}

async function listReviewFileTransactionIds(targetPath: string): Promise<string[]> {
  const targetDir = path.dirname(path.resolve(targetPath));
  const prefix = `.review-txn-${getReviewTransactionTargetKey(targetPath)}-`;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(prefix) &&
        /^[a-f0-9-]{36}$/i.test(entry.name.slice(prefix.length))
    )
    .map((entry) => entry.name.slice(prefix.length));
}

async function findMatchingReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'>
): Promise<ReviewFileTransactionDescriptor | null> {
  const matches: ReviewFileTransactionDescriptor[] = [];
  for (const id of await listReviewFileTransactionIds(input.targetPath)) {
    try {
      const transaction = { ...input, id };
      const manifest = await readReviewFileTransactionManifest(transaction);
      assertManifestMatchesTransaction(manifest, transaction);
      matches.push(transaction);
    } catch {
      // A transaction for another mutation of the same path is not ours to resume.
    }
  }
  if (matches.length > 1) {
    throw new Error('Multiple review file transactions match the same mutation');
  }
  return matches[0] ?? null;
}

export async function prepareReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'> & { id?: string },
  options: { mode?: number } = {}
): Promise<ReviewFileTransactionDescriptor> {
  const normalizedInput = {
    ...input,
    sourcePath: path.resolve(input.sourcePath),
    targetPath: path.resolve(input.targetPath),
  };
  const existing = input.id
    ? ({ ...normalizedInput, id: input.id } as ReviewFileTransactionDescriptor)
    : await findMatchingReviewFileTransaction(normalizedInput);
  if (existing) {
    const manifest = await readReviewFileTransactionManifest(existing);
    assertManifestMatchesTransaction(manifest, existing);
    return existing;
  }

  const transaction: ReviewFileTransactionDescriptor = {
    ...normalizedInput,
    id: randomUUID(),
  };
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  await fs.promises.mkdir(paths.directoryPath, { mode: 0o700 });
  try {
    if (transaction.nextContent !== null) {
      await fs.promises.writeFile(paths.afterPath, transaction.nextContent, {
        encoding: 'utf8',
        flag: 'wx',
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
      await syncFile(paths.afterPath, true);
    }
    await writeReviewFileTransactionManifest(transaction, 'prepared');
    await syncDirectoryBestEffort(path.dirname(paths.directoryPath));
    return transaction;
  } catch (error) {
    await fs.promises.rm(paths.directoryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function resumePreparedReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'>
): Promise<ReviewFileTransactionDescriptor | null> {
  const transaction = await findMatchingReviewFileTransaction({
    ...input,
    sourcePath: path.resolve(input.sourcePath),
    targetPath: path.resolve(input.targetPath),
  });
  if (!transaction) return null;
  await executeReviewFileTransaction(transaction);
  return transaction;
}

export async function finalizePreparedReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'>
): Promise<boolean> {
  const transaction = await findMatchingReviewFileTransaction({
    ...input,
    sourcePath: path.resolve(input.sourcePath),
    targetPath: path.resolve(input.targetPath),
  });
  if (!transaction) return false;
  await finalizeReviewFileTransaction(transaction);
  return true;
}

async function inspectOrDetachReviewTransactionSource(
  transaction: ReviewFileTransactionDescriptor,
  options: {
    expectedIdentity?: Pick<ExpectedTextFileIdentity, 'dev' | 'ino'>;
    beforeDetach?: () => Promise<void>;
  }
): Promise<void> {
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  let before = await lstatOrNull(paths.beforePath);
  if (!before) {
    const source = await assertRegularTextArtifact(
      transaction.sourcePath,
      transaction.expectedContent,
      options.expectedIdentity
    );
    if (source.nlink > 1) {
      throw new Error('Review mutation refuses symbolic or multiply-linked files');
    }
    await fs.promises.link(transaction.sourcePath, paths.beforePath);
    before = await assertRegularTextArtifact(paths.beforePath, transaction.expectedContent, source);
    const latestSource = await lstatOrNull(transaction.sourcePath);
    if (!latestSource || !isSameFileIdentity(latestSource, before)) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
  } else {
    await assertRegularTextArtifact(paths.beforePath, transaction.expectedContent);
  }

  let detached = await lstatOrNull(paths.detachedPath);
  if (!detached) {
    await options.beforeDetach?.();
    const source = await lstatOrNull(transaction.sourcePath);
    if (!source || !isSameFileIdentity(source, before)) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
    try {
      await renameWithRetry(transaction.sourcePath, paths.detachedPath);
    } catch (error) {
      detached = await lstatOrNull(paths.detachedPath);
      const latestSource = await lstatOrNull(transaction.sourcePath);
      if (!detached || !isSameFileIdentity(detached, before) || latestSource) throw error;
    }
    detached = await lstatOrNull(paths.detachedPath);
  }
  if (!detached || !isSameFileIdentity(detached, before)) {
    if (detached) {
      await restoreDetachedPathNoClobber(paths.detachedPath, transaction.sourcePath);
    }
    throw new Error('File changed during review update; refusing to mutate it');
  }
  await assertRegularTextArtifact(paths.detachedPath, transaction.expectedContent, before);
  await writeReviewFileTransactionManifest(transaction, 'detached');
  await syncRenamedDirectoriesBestEffort(transaction.sourcePath, paths.detachedPath);
}

export async function executeReviewFileTransaction(
  transaction: ReviewFileTransactionDescriptor,
  options: {
    expectedIdentity?: Pick<ExpectedTextFileIdentity, 'dev' | 'ino'>;
    beforeDetach?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
  } = {}
): Promise<void> {
  const manifest = await readReviewFileTransactionManifest(transaction);
  assertManifestMatchesTransaction(manifest, transaction);
  if (manifest.phase === 'published') return;

  await inspectOrDetachReviewTransactionSource(transaction, options);
  if (transaction.kind === 'delete') {
    await writeReviewFileTransactionManifest(transaction, 'published');
    return;
  }

  if (transaction.nextContent === null) {
    throw new Error('Review replace/move transaction is missing its postimage');
  }
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  const after = await assertRegularTextArtifact(paths.afterPath, transaction.nextContent);
  await options.beforePublish?.();
  const target = await lstatOrNull(transaction.targetPath);
  if (target && !isSameFileIdentity(target, after)) {
    throw new Error('Review mutation target appeared during publish; refusing overwrite');
  }
  if (!target) {
    await publishHardlinkNoClobber(paths.afterPath, transaction.targetPath);
  }
  const published = await fs.promises.lstat(transaction.targetPath);
  if (!isSameFileIdentity(published, after)) {
    throw new Error('Review mutation target changed during publish; refusing overwrite');
  }
  if (transaction.kind === 'move' && (await lstatOrNull(transaction.sourcePath))) {
    throw new Error('Review rename source reappeared during publish; refusing ambiguous state');
  }
  await writeReviewFileTransactionManifest(transaction, 'published');
}

export async function inspectReviewFileTransaction(
  transaction: ReviewFileTransactionDescriptor
): Promise<'missing' | 'prepared' | 'detached' | 'published' | 'conflict'> {
  try {
    const manifest = await readReviewFileTransactionManifest(transaction);
    assertManifestMatchesTransaction(manifest, transaction);
    const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
    const before = await lstatOrNull(paths.beforePath);
    const detached = await lstatOrNull(paths.detachedPath);
    if (manifest.phase === 'prepared' && !before && !detached) return 'prepared';
    if (!before || !detached || !isSameFileIdentity(before, detached)) return 'conflict';
    await assertRegularTextArtifact(paths.beforePath, transaction.expectedContent);
    if (manifest.phase !== 'published') return 'detached';
    const target = await lstatOrNull(transaction.targetPath);
    if (transaction.kind === 'delete') {
      return target ? 'conflict' : 'published';
    }
    if (transaction.nextContent === null) return 'conflict';
    const after = await lstatOrNull(paths.afterPath);
    if (!after || !target || !isSameFileIdentity(after, target)) return 'conflict';
    await assertRegularTextArtifact(paths.afterPath, transaction.nextContent);
    if (transaction.kind === 'move' && (await lstatOrNull(transaction.sourcePath))) {
      return 'conflict';
    }
    return 'published';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'conflict';
  }
}

export async function finalizeReviewFileTransaction(
  transaction: ReviewFileTransactionDescriptor
): Promise<void> {
  const state = await inspectReviewFileTransaction(transaction);
  if (state === 'missing') return;
  if (state !== 'published') {
    throw new Error('Review file transaction is not durably published');
  }
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  for (const artifactPath of [
    paths.afterPath,
    paths.detachedPath,
    paths.beforePath,
    paths.manifestPath,
  ]) {
    await fs.promises.unlink(artifactPath).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    });
  }
  await fs.promises.rmdir(paths.directoryPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  });
  await syncDirectoryBestEffort(path.dirname(paths.directoryPath));
  if (path.dirname(transaction.sourcePath) !== path.dirname(transaction.targetPath)) {
    await syncDirectoryBestEffort(path.dirname(transaction.sourcePath));
  }
}

export async function isOwnedReviewFileTransactionHardlink(targetPath: string): Promise<boolean> {
  const target = await lstatOrNull(targetPath);
  if (!target || target.nlink <= 1 || target.isSymbolicLink() || !target.isFile()) return false;
  let matchingLinks = 0;
  for (const id of await listReviewFileTransactionIds(targetPath)) {
    const paths = getReviewFileTransactionPaths(targetPath, id);
    for (const artifactPath of [paths.beforePath, paths.detachedPath, paths.afterPath]) {
      const artifact = await lstatOrNull(artifactPath);
      if (artifact && isSameFileIdentity(target, artifact)) matchingLinks++;
    }
  }
  return matchingLinks > 0 && target.nlink === matchingLinks + 1;
}

async function syncFile(filePath: string, strict: boolean): Promise<void> {
  let fd: fs.promises.FileHandle | null = null;
  let firstError: unknown = null;
  try {
    fd = await fs.promises.open(filePath, 'r+');
    await fd.sync();
  } catch (error) {
    firstError = error;
  } finally {
    try {
      await fd?.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError && strict) {
    throw firstError instanceof Error
      ? firstError
      : new Error('File synchronization failed with a non-Error value', { cause: firstError });
  }
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) return true;
  // Windows does not provide a portable directory handle that can be fsynced.
  // Keep only the platform-specific open/sync failures best-effort there; real
  // storage failures such as EIO and ENOSPC must still fail strict operations.
  return (
    process.platform === 'win32' &&
    (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF')
  );
}

async function syncDirectory(dirPath: string, strict: boolean): Promise<void> {
  let fd: fs.promises.FileHandle | null = null;
  let firstError: unknown = null;
  try {
    fd = await fs.promises.open(dirPath, 'r');
    await fd.sync();
  } catch (error) {
    firstError = error;
  } finally {
    try {
      await fd?.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (strict && firstError && !isUnsupportedDirectorySyncError(firstError)) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Directory synchronization failed with a non-Error value', {
          cause: firstError,
        });
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, false);
}

export async function syncDirectoryDurably(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, true);
}

async function syncRenamedDirectoriesBestEffort(src: string, dest: string): Promise<void> {
  await syncRenamedDirectories(src, dest, false);
}

async function syncRenamedDirectories(src: string, dest: string, strict: boolean): Promise<void> {
  const sourceDir = path.dirname(src);
  const destinationDir = path.dirname(dest);
  await syncDirectory(destinationDir, strict);
  if (sourceDir !== destinationDir) {
    await syncDirectory(sourceDir, strict);
  }
}

export async function unlinkPathDurably(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath);
  await syncDirectory(path.dirname(filePath), true);
}

/** Remove only crash-left atomic-create temp names that still reference this exact inode. */
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
