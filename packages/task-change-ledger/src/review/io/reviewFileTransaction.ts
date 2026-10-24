import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { hasUnexpectedMoveSource } from './moveSourceIdentity.js';
import {
  atomicWriteAsync,
  renameWithRetry,
  syncRenamedDirectories,
  syncFile,
} from './atomicPersistence.js';
import { syncDirectoryBestEffort } from './atomicCreate.js';
import { sameArtifact, unlinkOwnedArtifact, writeGuardedTemp } from './mutationAuthority.js';
import type { MutationAuthorityOptions } from './mutationAuthority.js';

export { isOwnedReviewFileTransactionHardlink } from './reviewFileTransactionOwnership.js';

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
  targetPath: string,
  options: MutationAuthorityOptions
): Promise<boolean> {
  try {
    const owned = options.assertCurrent ? await fs.promises.lstat(detachedPath) : undefined;
    options.assertCurrent?.();
    await fs.promises.link(detachedPath, targetPath);
    options.assertCurrent?.();
    if (options.assertCurrent) unlinkOwnedArtifact(detachedPath, owned, options);
    else await fs.promises.unlink(detachedPath);
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

async function publishHardlinkNoClobber(
  sourcePath: string,
  targetPath: string,
  options: MutationAuthorityOptions
): Promise<void> {
  try {
    options.assertCurrent?.();
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
  phase: ReviewFileTransactionManifest['phase'],
  options: MutationAuthorityOptions
): Promise<void> {
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  await atomicWriteAsync(
    paths.manifestPath,
    `${JSON.stringify(buildReviewFileTransactionManifest(transaction, phase), null, 2)}\n`,
    {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
      ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
    }
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
  options: { mode?: number } & MutationAuthorityOptions = {}
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
  options.assertCurrent?.();
  await fs.promises.mkdir(paths.directoryPath, { mode: 0o700 });
  try {
    if (transaction.nextContent !== null) {
      options.assertCurrent?.();
      if (options.assertCurrent)
        await writeGuardedTemp(
          paths.afterPath,
          transaction.nextContent,
          options.mode,
          options,
          () => {}
        );
      else
        await fs.promises.writeFile(paths.afterPath, transaction.nextContent, {
          encoding: 'utf8',
          flag: 'wx',
          ...(options.mode === undefined ? {} : { mode: options.mode }),
        });
      await syncFile(paths.afterPath, true);
    }
    await writeReviewFileTransactionManifest(transaction, 'prepared', options);
    await syncDirectoryBestEffort(path.dirname(paths.directoryPath));
    return transaction;
  } catch (error) {
    if (!options.assertCurrent)
      await fs.promises.rm(paths.directoryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function resumePreparedReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'>,
  options: MutationAuthorityOptions = {}
): Promise<ReviewFileTransactionDescriptor | null> {
  const transaction = await findMatchingReviewFileTransaction({
    ...input,
    sourcePath: path.resolve(input.sourcePath),
    targetPath: path.resolve(input.targetPath),
  });
  if (!transaction) return null;
  await executeReviewFileTransaction(transaction, options);
  return transaction;
}

export async function finalizePreparedReviewFileTransaction(
  input: Omit<ReviewFileTransactionDescriptor, 'id'>,
  options: MutationAuthorityOptions = {}
): Promise<boolean> {
  const transaction = await findMatchingReviewFileTransaction({
    ...input,
    sourcePath: path.resolve(input.sourcePath),
    targetPath: path.resolve(input.targetPath),
  });
  if (!transaction) return false;
  await finalizeReviewFileTransaction(transaction, options);
  return true;
}

async function inspectOrDetachReviewTransactionSource(
  transaction: ReviewFileTransactionDescriptor,
  options: {
    expectedIdentity?: Pick<ExpectedTextFileIdentity, 'dev' | 'ino'>;
    beforeDetach?: () => Promise<void>;
    assertCurrent?: () => void;
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
    options.assertCurrent?.();
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
    if (!source.isFile() || source.nlink !== 2) {
      throw new Error('Review mutation refuses symbolic or multiply-linked files');
    }
    try {
      await renameWithRetry(
        transaction.sourcePath,
        paths.detachedPath,
        undefined,
        options.assertCurrent
      );
    } catch (error) {
      detached = await lstatOrNull(paths.detachedPath);
      const latestSource = await lstatOrNull(transaction.sourcePath);
      if (!detached || !isSameFileIdentity(detached, before) || latestSource) throw error;
    }
    detached = await lstatOrNull(paths.detachedPath);
  }
  if (!detached || !isSameFileIdentity(detached, before)) {
    if (detached) {
      await restoreDetachedPathNoClobber(paths.detachedPath, transaction.sourcePath, options);
    }
    throw new Error('File changed during review update; refusing to mutate it');
  }
  await assertRegularTextArtifact(paths.detachedPath, transaction.expectedContent, before);
  await writeReviewFileTransactionManifest(transaction, 'detached', options);
  await syncRenamedDirectoriesBestEffort(transaction.sourcePath, paths.detachedPath);
}

export async function executeReviewFileTransaction(
  transaction: ReviewFileTransactionDescriptor,
  options: {
    expectedIdentity?: Pick<ExpectedTextFileIdentity, 'dev' | 'ino'>;
    beforeDetach?: () => Promise<void>;
    assertCurrent?: () => void;
    beforePublish?: () => Promise<void>;
  } = {}
): Promise<void> {
  options.assertCurrent?.();
  const manifest = await readReviewFileTransactionManifest(transaction);
  options.assertCurrent?.();
  assertManifestMatchesTransaction(manifest, transaction);
  if (manifest.phase === 'published') return;

  await inspectOrDetachReviewTransactionSource(transaction, options);
  if (transaction.kind === 'delete') {
    await writeReviewFileTransactionManifest(transaction, 'published', options);
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
    await publishHardlinkNoClobber(paths.afterPath, transaction.targetPath, options);
  }
  const published = await fs.promises.lstat(transaction.targetPath);
  if (!isSameFileIdentity(published, after)) {
    throw new Error('Review mutation target changed during publish; refusing overwrite');
  }
  if (
    transaction.kind === 'move' &&
    (await hasUnexpectedMoveSource(transaction.sourcePath, transaction.targetPath, published))
  ) {
    throw new Error('Review rename source reappeared during publish; refusing ambiguous state');
  }
  await writeReviewFileTransactionManifest(transaction, 'published', options);
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
    if (manifest.phase === 'prepared' && !detached) {
      if (!before) return 'prepared';
      const source = await lstatOrNull(transaction.sourcePath);
      if (
        !source?.isFile() ||
        !isSameFileIdentity(before, source) ||
        before.nlink !== 2 ||
        source.nlink !== 2
      ) {
        return 'conflict';
      }
      await assertRegularTextArtifact(paths.beforePath, transaction.expectedContent, source);
      return 'prepared';
    }
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
    if (
      transaction.kind === 'move' &&
      (await hasUnexpectedMoveSource(transaction.sourcePath, transaction.targetPath, target))
    ) {
      return 'conflict';
    }
    return 'published';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'conflict';
  }
}

export async function finalizeReviewFileTransaction(
  transaction: ReviewFileTransactionDescriptor,
  options: MutationAuthorityOptions = {}
): Promise<void> {
  options.assertCurrent?.();
  const paths = getReviewFileTransactionPaths(transaction.targetPath, transaction.id);
  const artifactPaths = [paths.afterPath, paths.detachedPath, paths.beforePath, paths.manifestPath];
  const pinned = new Map<string, fs.Stats>();
  if (options.assertCurrent) {
    for (const name of [paths.directoryPath, ...artifactPaths]) {
      try {
        pinned.set(name, fs.lstatSync(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const state = await inspectReviewFileTransaction(transaction);
  options.assertCurrent?.();
  if (state === 'missing') return;
  if (state !== 'published') {
    throw new Error('Review file transaction is not durably published');
  }
  for (const artifactPath of artifactPaths) {
    if (options.assertCurrent) {
      options.assertCurrent();
      unlinkOwnedArtifact(artifactPath, pinned.get(artifactPath), options);
      continue;
    }
    await fs.promises.unlink(artifactPath).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    });
  }
  options.assertCurrent?.();
  if (options.assertCurrent) {
    const directory = pinned.get(paths.directoryPath);
    if (!directory || !sameArtifact(fs.lstatSync(paths.directoryPath), directory))
      throw new Error('Transaction directory changed before cleanup');
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

async function syncRenamedDirectoriesBestEffort(src: string, dest: string): Promise<void> {
  await syncRenamedDirectories(src, dest, false);
}
