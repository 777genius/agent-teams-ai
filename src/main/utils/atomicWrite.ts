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
  /** Reports whether requested directory durability was achieved or used a safe fallback. */
  onDirectorySyncOutcome?: (outcome: AtomicWriteDirectorySyncOutcome) => void;
  /**
   * Runs after the temporary file is complete and synced, immediately before every
   * publish attempt (including Windows retries).
   * Callers can use this to repeat a compare-and-swap guard without exposing a
   * partially-written target.
   */
  beforeCommit?: () => Promise<void>;
}

export type AtomicWriteDirectorySyncOutcome =
  | 'durable'
  | 'unsupported-platform'
  | 'best-effort-unavailable'
  | 'failed-after-publish';

export interface AtomicCreateResult {
  dev: number;
  ino: number;
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
  options: { syncDirectories?: boolean } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      if (options.syncDirectories) {
        await syncRenamedDirectoriesBestEffort(src, dest);
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
 * Supports strict or best-effort fsync and bounded Windows transient rename retries for safety.
 */
export async function atomicWriteAsync(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);
  let directorySync: DirectorySyncPreparation | null = null;

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, data, {
      ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });

    await syncFile(tmpPath, options.durability === 'strict');
    if (options.syncDirectory) {
      // Establish directory-fsync support before the rename. Once rename succeeds the new bytes are
      // already published, so a later fsync/close error must not be surfaced as a failed write.
      directorySync = await prepareDirectorySync(dir, options.durability === 'strict');
    }
    await renameWithRetry(tmpPath, targetPath, options.beforeCommit);
    const directorySyncOutcome = await finishDirectorySyncAfterPublish(directorySync);
    directorySync = null;
    if (directorySyncOutcome) {
      try {
        options.onDirectorySyncOutcome?.(directorySyncOutcome);
      } catch {
        // Publication and any supported durability work are already complete. Observers cannot
        // retroactively turn that terminal outcome into an ambiguous write failure.
      }
    }
  } catch (error) {
    await closeDirectorySync(directorySync);
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
    await syncDirectoryBestEffort(dir);
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
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

type DirectorySyncPreparation =
  | { readonly status: 'ready'; readonly handle: fs.promises.FileHandle }
  | { readonly status: 'unsupported-platform' | 'best-effort-unavailable' };

async function prepareDirectorySync(
  dirPath: string,
  strict: boolean
): Promise<DirectorySyncPreparation> {
  // Node cannot reliably open directory handles on Windows. File fsync plus atomic rename remains
  // the strongest supported behavior there; treating that platform limitation as a failed write
  // would break callers even though their target was publishable.
  if (process.platform === 'win32') {
    return { status: 'unsupported-platform' };
  }

  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(dirPath, 'r');
    // Probe support before publication. This also persists the temporary directory entry.
    await fd.sync();
    return { status: 'ready', handle: fd };
  } catch (error) {
    await fd?.close().catch(() => undefined);
    if (strict) {
      throw error instanceof Error
        ? error
        : new Error('Directory synchronization failed with a non-Error value', { cause: error });
    }
    return { status: 'best-effort-unavailable' };
  }
}

async function closeDirectorySync(preparation: DirectorySyncPreparation | null): Promise<void> {
  if (preparation?.status !== 'ready') return;
  await preparation.handle.close().catch(() => undefined);
}

async function finishDirectorySyncAfterPublish(
  preparation: DirectorySyncPreparation | null
): Promise<AtomicWriteDirectorySyncOutcome | null> {
  if (!preparation) return null;
  if (preparation.status !== 'ready') return preparation.status;

  try {
    await preparation.handle.sync();
    return 'durable';
  } catch {
    // rename already published the complete file. Do not turn a durability uncertainty into a
    // misleading publication failure; a later write can safely retry the same current snapshot.
    return 'failed-after-publish';
  } finally {
    await closeDirectorySync(preparation);
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(dirPath, 'r');
    await fd.sync();
  } catch {
    // Directory fsync is unsupported on some platforms (notably Windows).
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

async function syncRenamedDirectoriesBestEffort(src: string, dest: string): Promise<void> {
  const sourceDir = path.dirname(src);
  const destinationDir = path.dirname(dest);
  await syncDirectoryBestEffort(destinationDir);
  if (sourceDir !== destinationDir) {
    await syncDirectoryBestEffort(sourceDir);
  }
}

export async function unlinkPathDurably(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath);
  await syncDirectoryBestEffort(path.dirname(filePath));
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
