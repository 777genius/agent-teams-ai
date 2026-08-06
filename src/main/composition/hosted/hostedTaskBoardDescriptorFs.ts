import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { type DurablePathIdentity } from '@main/utils/durablePathOperations';

const DESCRIPTOR_ROOT = '/proc/self/fd';
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const DIRECTORY = fs.constants.O_DIRECTORY;
export class HostedTaskBoardDescriptorFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedTaskBoardDescriptorFsError';
  }
}

const descriptorError = (message: string) => new HostedTaskBoardDescriptorFsError(message);

export interface HostedTaskBoardDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface HostedTaskBoardDirectoryDescriptor {
  readonly handle: fs.promises.FileHandle;
  readonly identity: HostedTaskBoardDirectoryIdentity;
  readonly parent: HostedTaskBoardDirectoryDescriptor | null;
  readonly name: string | null;
  readonly expectedPath: string;
}

export interface HostedTaskBoardFileStamp {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly durableIdentity: DurablePathIdentity;
  readonly contentHash: string;
}

export interface HostedTaskBoardPersistedFileStamp {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly durableDevice: number;
  readonly durableInode: number;
  readonly birthtimeMs: number;
  readonly contentHash: string;
}
interface HostedTaskBoardFileSnapshotBase {
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly name: string;
  readonly maximumBytes: number;
}
export type HostedTaskBoardFileSnapshot =
  | (HostedTaskBoardFileSnapshotBase & { readonly exists: false })
  | (HostedTaskBoardFileSnapshotBase & {
      readonly exists: true;
      readonly text: string;
      readonly stamp: HostedTaskBoardFileStamp;
    });

export type HostedTaskBoardExistingFilePublicationCheckpoint =
  | 'existing_target_postimage_ready'
  | 'existing_target_precommit_validated'
  | 'existing_target_preimage_detached'
  | 'existing_target_replaced';

const contentHash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const assertActive = (assertActive: (() => void) | undefined): void => assertActive?.();

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw descriptorError('hosted-task-board-descriptor-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function noFollowDirectoryFlags(): number {
  if (![NO_FOLLOW, DIRECTORY].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw descriptorError('hosted-task-board-descriptor-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY;
}

function validChildName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

export function isHostedTaskBoardChildName(value: unknown): value is string {
  return typeof value === 'string' && validChildName(value);
}

export function hostedTaskBoardUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

const directoryIdentity = (
  canonicalPath: string,
  stat: fs.BigIntStats
): HostedTaskBoardDirectoryIdentity =>
  Object.freeze({ canonicalPath, device: stat.dev, inode: stat.ino });

function sameDirectoryIdentity(
  left: HostedTaskBoardDirectoryIdentity,
  right: HostedTaskBoardDirectoryIdentity
): boolean {
  return [left.canonicalPath, left.device, left.inode].every(
    (value, index) => value === [right.canonicalPath, right.device, right.inode][index]
  );
}

function stampFrom(
  stat: fs.BigIntStats,
  durableStat: fs.Stats,
  text: string
): HostedTaskBoardFileStamp {
  if (
    !Number.isSafeInteger(durableStat.dev) ||
    !Number.isSafeInteger(durableStat.ino) ||
    durableStat.ino <= 0 ||
    !Number.isFinite(durableStat.birthtimeMs)
  ) {
    throw descriptorError('hosted-task-board-descriptor-file-identity-invalid');
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    durableIdentity: Object.freeze({
      dev: durableStat.dev,
      ino: durableStat.ino,
      birthtimeMs: durableStat.birthtimeMs,
    }),
    contentHash: contentHash(text),
  });
}

function sameUnhashedFileIdentity(left: HostedTaskBoardFileStamp, stat: fs.BigIntStats): boolean {
  return (
    left.device === stat.dev &&
    left.inode === stat.ino &&
    left.size === stat.size &&
    left.mtimeNs === stat.mtimeNs &&
    left.ctimeNs === stat.ctimeNs
  );
}

export function sameHostedTaskBoardFileStamp(
  left: HostedTaskBoardFileStamp,
  right: HostedTaskBoardFileStamp
): boolean {
  return matchesHostedTaskBoardPersistedFileStamp(
    serializeHostedTaskBoardPersistedFileStamp(left),
    right
  );
}

export function serializeHostedTaskBoardPersistedFileStamp(
  stamp: HostedTaskBoardFileStamp
): HostedTaskBoardPersistedFileStamp {
  return Object.freeze({
    device: stamp.device.toString(),
    inode: stamp.inode.toString(),
    size: stamp.size.toString(),
    mtimeNs: stamp.mtimeNs.toString(),
    ctimeNs: stamp.ctimeNs.toString(),
    durableDevice: stamp.durableIdentity.dev,
    durableInode: stamp.durableIdentity.ino,
    birthtimeMs: stamp.durableIdentity.birthtimeMs,
    contentHash: stamp.contentHash,
  });
}
export function parseHostedTaskBoardPersistedFileStamp(
  value: unknown
): HostedTaskBoardPersistedFileStamp {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    record === null ||
    !hasExactHostedTaskBoardRecordKeys(record, [
      'device',
      'inode',
      'size',
      'mtimeNs',
      'ctimeNs',
      'durableDevice',
      'durableInode',
      'birthtimeMs',
      'contentHash',
    ]) ||
    !isDecimalString(record.device) ||
    !isDecimalString(record.inode) ||
    !isDecimalString(record.size) ||
    !isDecimalString(record.mtimeNs) ||
    !isDecimalString(record.ctimeNs) ||
    !Number.isSafeInteger(record.durableDevice) ||
    !Number.isSafeInteger(record.durableInode) ||
    (record.durableInode as number) <= 0 ||
    !Number.isFinite(record.birthtimeMs) ||
    typeof record.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.contentHash)
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-persisted-file-stamp-invalid');
  }
  return Object.freeze({
    device: record.device,
    inode: record.inode,
    size: record.size,
    mtimeNs: record.mtimeNs,
    ctimeNs: record.ctimeNs,
    durableDevice: record.durableDevice as number,
    durableInode: record.durableInode as number,
    birthtimeMs: record.birthtimeMs as number,
    contentHash: record.contentHash,
  });
}
export function matchesHostedTaskBoardPersistedFileStamp(
  expected: HostedTaskBoardPersistedFileStamp,
  actual: HostedTaskBoardFileStamp
): boolean {
  return (
    JSON.stringify(expected) === JSON.stringify(serializeHostedTaskBoardPersistedFileStamp(actual))
  );
}

function matchesHostedTaskBoardPreimageAfterRename(
  expected: HostedTaskBoardPersistedFileStamp,
  actual: HostedTaskBoardFileStamp
): boolean {
  return matchesHostedTaskBoardPersistedFileStamp(
    { ...expected, ctimeNs: actual.ctimeNs.toString() },
    actual
  );
}

export function hasExactHostedTaskBoardRecordKeys(
  record: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(record, key))
  );
}
const isDecimalString = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+$/.test(value);
export function descriptorPath(directory: HostedTaskBoardDirectoryDescriptor): string {
  if (!Number.isSafeInteger(directory.handle.fd) || directory.handle.fd < 0) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-directory-invalid');
  }
  return join(DESCRIPTOR_ROOT, String(directory.handle.fd));
}

export function descriptorChildPath(
  parent: HostedTaskBoardDirectoryDescriptor,
  name: string
): string {
  if (!validChildName(name)) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-child-invalid');
  }
  return join(descriptorPath(parent), name);
}

async function clearHostedTaskBoardExistingPublicationArtifacts(input: {
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly stageName: string;
  readonly preimage: {
    readonly text: string;
    readonly stamp: HostedTaskBoardPersistedFileStamp;
  };
  readonly postimage: string;
  readonly maximumBytes: number;
  readonly assertStillActive?: () => void;
}): Promise<void> {
  const read = (name: string) =>
    readHostedTaskBoardFile(input.parent, name, input.maximumBytes, {
      optional: true,
      assertStillActive: input.assertStillActive,
    });
  const pinName = `${input.stageName}.pin`;
  const [stage, pin] = await Promise.all([read(input.stageName), read(pinName)]);
  if (
    (stage.exists && stage.text !== input.postimage) ||
    (pin.exists &&
      (pin.text !== input.preimage.text ||
        !matchesHostedTaskBoardPreimageAfterRename(input.preimage.stamp, pin.stamp)))
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  for (const artifact of [stage, pin]) {
    if (artifact.exists) await fs.promises.unlink(descriptorChildPath(input.parent, artifact.name));
  }
  if (stage.exists || pin.exists) await input.parent.handle.sync();
}

export async function recoverHostedTaskBoardExistingFilePublication(input: {
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly name: string;
  readonly stageName: string;
  readonly preimage: { readonly text: string; readonly stamp: HostedTaskBoardPersistedFileStamp };
  readonly postimage: string;
  readonly maximumBytes: number;
  readonly assertStillActive?: () => void;
}): Promise<void> {
  const read = (name: string) =>
    readHostedTaskBoardFile(input.parent, name, input.maximumBytes, {
      optional: true,
      assertStillActive: input.assertStillActive,
    });
  const target = await read(input.name);
  if (target.exists && target.text === input.postimage) {
    await clearHostedTaskBoardExistingPublicationArtifacts(input);
    return;
  }
  const [stage, pin] = await Promise.all([read(input.stageName), read(`${input.stageName}.pin`)]);
  if (
    target.exists ||
    !stage.exists ||
    stage.text !== input.postimage ||
    !pin.exists ||
    pin.text !== input.preimage.text ||
    !matchesHostedTaskBoardPreimageAfterRename(input.preimage.stamp, pin.stamp)
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  try {
    await fs.promises.link(
      descriptorChildPath(input.parent, input.stageName),
      descriptorChildPath(input.parent, input.name)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  await input.parent.handle.sync();
  const published = await read(input.name);
  if (!published.exists || published.text !== input.postimage) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await clearHostedTaskBoardExistingPublicationArtifacts(input);
}

export async function publishHostedTaskBoardExistingFile(input: {
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly name: string;
  readonly stageName: string;
  readonly expected: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly postimage: string;
  readonly maximumBytes: number;
  readonly assertStillActive?: () => void;
  readonly beforeFinalValidation?: () => Promise<void> | void;
  readonly beforeCommit: () => Promise<void>;
  readonly beforeTargetDetach?: () => Promise<void> | void;
  readonly beforeTargetLink?: () => Promise<void> | void;
  readonly onPublicationCheckpoint?: (
    checkpoint: HostedTaskBoardExistingFilePublicationCheckpoint
  ) => Promise<void> | void;
}): Promise<void> {
  if (
    !validChildName(input.name) ||
    !validChildName(input.stageName) ||
    input.expected.parent !== input.parent ||
    input.expected.name !== input.name ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    Buffer.byteLength(input.postimage, 'utf8') < 1 ||
    Buffer.byteLength(input.postimage, 'utf8') > input.maximumBytes
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-invalid');
  }
  const temporaryName = `${input.stageName}.tmp`;
  const pinName = `${input.stageName}.pin`;
  if (!validChildName(temporaryName)) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-invalid');
  }
  const childPath = (name: string) => descriptorChildPath(input.parent, name);
  const stagePath = childPath(input.stageName);
  const temporaryPath = childPath(temporaryName);
  const expectedStamp = serializeHostedTaskBoardPersistedFileStamp(input.expected.stamp);
  const readStage = (name: string) =>
    readHostedTaskBoardFile(input.parent, name, input.maximumBytes, {
      optional: true,
      assertStillActive: input.assertStillActive,
    });
  const assertPostimage = (
    snapshot: HostedTaskBoardFileSnapshot
  ): Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }> => {
    if (!snapshot.exists || snapshot.text !== input.postimage) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
    }
    return snapshot;
  };
  const discard = async (name: string) => {
    await revalidateHostedTaskBoardDirectories([input.parent], input.assertStillActive);
    try {
      const artifact = await fs.promises.lstat(childPath(name), { bigint: true });
      if (artifact.isDirectory()) {
        throw descriptorError('hosted-task-board-descriptor-stage-substituted');
      }
      await fs.promises.unlink(childPath(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  let stage = await readStage(input.stageName);
  if (stage.exists) stage = assertPostimage(stage);
  if (!stage.exists) {
    await discard(temporaryName);
    let temporary: fs.promises.FileHandle | null = null;
    try {
      temporary = await fs.promises.open(temporaryPath, 'wx', 0o600);
      await temporary.writeFile(input.postimage, 'utf8');
      await temporary.sync();
      await fs.promises.link(temporaryPath, stagePath);
      await input.parent.handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await temporary?.close().catch(() => undefined);
    }
    stage = assertPostimage(await readStage(input.stageName));
  }
  await discard(temporaryName);
  const initialStage = assertPostimage(await readStage(input.stageName));
  if ((await readStage(pinName)).exists) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.beforeFinalValidation?.();
  const finalStage = assertPostimage(await readStage(input.stageName));
  if (!sameHostedTaskBoardFileStamp(initialStage.stamp, finalStage.stamp)) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.onPublicationCheckpoint?.('existing_target_postimage_ready');
  await input.beforeCommit();
  await input.onPublicationCheckpoint?.('existing_target_precommit_validated');
  assertActive(input.assertStillActive);
  if ((await readStage(pinName)).exists) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.beforeTargetDetach?.();
  try {
    await fs.promises.rename(childPath(input.name), childPath(pinName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  try {
    const pinned = await readStage(pinName);
    if (!pinned.exists || !matchesHostedTaskBoardPreimageAfterRename(expectedStamp, pinned.stamp)) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
    }
  } catch (error) {
    try {
      await fs.promises.link(childPath(pinName), childPath(input.name));
      await fs.promises.unlink(childPath(pinName));
      await input.parent.handle.sync();
    } catch {
      // Best-effort rollback preserves the original publish error.
    }
    throw error;
  }
  await input.parent.handle.sync();
  await input.onPublicationCheckpoint?.('existing_target_preimage_detached');
  await input.beforeTargetLink?.();
  try {
    await fs.promises.link(stagePath, childPath(input.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  await input.onPublicationCheckpoint?.('existing_target_replaced');
  await input.parent.handle.sync();
  await clearHostedTaskBoardExistingPublicationArtifacts({
    parent: input.parent,
    stageName: input.stageName,
    preimage: {
      text: input.expected.text,
      stamp: expectedStamp,
    },
    postimage: input.postimage,
    maximumBytes: input.maximumBytes,
    assertStillActive: input.assertStillActive,
  });
}
export async function openHostedTaskBoardDirectory(
  expectedPath: string,
  parent: HostedTaskBoardDirectoryDescriptor | null,
  name: string | null,
  assertStillActive?: () => void
): Promise<HostedTaskBoardDirectoryDescriptor> {
  assertActive(assertStillActive);
  if (!isAbsolute(expectedPath) || resolve(expectedPath) !== expectedPath) {
    throw descriptorError('hosted-task-board-descriptor-directory-path-invalid');
  }
  const target =
    parent === null
      ? name === null
        ? expectedPath
        : null
      : name === null
        ? null
        : descriptorChildPath(parent, name);
  if (target === null) {
    throw descriptorError('hosted-task-board-descriptor-directory-child-invalid');
  }

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(target, noFollowDirectoryFlags());
    assertActive(assertStillActive);
    const stat = await handle.stat({ bigint: true });
    assertActive(assertStillActive);
    const canonicalPath = await fs.promises.realpath(join(DESCRIPTOR_ROOT, String(handle.fd)));
    assertActive(assertStillActive);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath !== expectedPath) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-directory-invalid');
    }
    const descriptor = Object.freeze({
      handle,
      identity: directoryIdentity(canonicalPath, stat),
      parent,
      name,
      expectedPath,
    });
    handle = null;
    return descriptor;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function openHostedTaskBoardFile(
  parent: HostedTaskBoardDirectoryDescriptor,
  name: string,
  assertStillActive?: () => void
): Promise<fs.promises.FileHandle> {
  assertActive(assertStillActive);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(descriptorChildPath(parent, name), noFollowReadFlags());
    assertActive(assertStillActive);
    const result = handle;
    handle = null;
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readHostedTaskBoardFile(
  parent: HostedTaskBoardDirectoryDescriptor,
  name: string,
  maximumBytes: number,
  options: { readonly optional?: boolean; readonly assertStillActive?: () => void } = {}
): Promise<HostedTaskBoardFileSnapshot> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-budget-invalid');
  }
  await revalidateHostedTaskBoardDirectories([parent], options.assertStillActive);
  const absent = (): HostedTaskBoardFileSnapshot =>
    Object.freeze({ parent, name, maximumBytes, exists: false });
  let handle: fs.promises.FileHandle;
  try {
    handle = await openHostedTaskBoardFile(parent, name, options.assertStillActive);
  } catch (error) {
    if (options.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      await revalidateHostedTaskBoardDirectories([parent], options.assertStillActive);
      return absent();
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    const durableBefore = await handle.stat();
    assertActive(options.assertStillActive);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-invalid');
    }
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      assertActive(options.assertStillActive);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      assertActive(options.assertStillActive);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const text = bytes.subarray(0, offset).toString('utf8');
    const stamp = stampFrom(before, durableBefore, text);
    const after = await handle.stat({ bigint: true });
    const named = await fs.promises.lstat(descriptorChildPath(parent, name), { bigint: true });
    assertActive(options.assertStillActive);
    if (
      offset > maximumBytes ||
      BigInt(offset) !== after.size ||
      !sameUnhashedFileIdentity(stamp, after) ||
      !sameUnhashedFileIdentity(stamp, named)
    ) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    await revalidateHostedTaskBoardDirectories([parent], options.assertStillActive);
    return Object.freeze({ parent, name, maximumBytes, exists: true, text, stamp });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameSnapshot(
  expected: HostedTaskBoardFileSnapshot,
  actual: HostedTaskBoardFileSnapshot
): boolean {
  if (expected.exists !== actual.exists) return false;
  if (!expected.exists || !actual.exists) return true;
  return (
    expected.text === actual.text && sameHostedTaskBoardFileStamp(expected.stamp, actual.stamp)
  );
}

export async function revalidateHostedTaskBoardFile(
  snapshot: HostedTaskBoardFileSnapshot,
  assertStillActive?: () => void
): Promise<void> {
  const actual = await readHostedTaskBoardFile(
    snapshot.parent,
    snapshot.name,
    snapshot.maximumBytes,
    {
      optional: true,
      assertStillActive,
    }
  );
  if (!sameSnapshot(snapshot, actual)) {
    throw descriptorError('hosted-task-board-descriptor-file-revalidation-failed');
  }
}

export async function revalidateHostedTaskBoardDirectories(
  directories: readonly HostedTaskBoardDirectoryDescriptor[],
  assertStillActive?: () => void
): Promise<void> {
  const validated = new Set<HostedTaskBoardDirectoryDescriptor>();
  const verify = async (directory: HostedTaskBoardDirectoryDescriptor): Promise<void> => {
    if (validated.has(directory)) return;
    if (directory.parent !== null) {
      if (directory.name === null) {
        throw descriptorError('hosted-task-board-descriptor-directory-membership-invalid');
      }
      await verify(directory.parent);
      let member: fs.promises.FileHandle | null = null;
      try {
        member = await fs.promises.open(
          descriptorChildPath(directory.parent, directory.name),
          noFollowDirectoryFlags()
        );
        const [memberStat, memberCanonicalPath] = await Promise.all([
          member.stat({ bigint: true }),
          fs.promises.realpath(join(DESCRIPTOR_ROOT, String(member.fd))),
        ]);
        assertActive(assertStillActive);
        if (
          !memberStat.isDirectory() ||
          memberStat.isSymbolicLink() ||
          memberCanonicalPath !== directory.expectedPath ||
          !sameDirectoryIdentity(
            directory.identity,
            directoryIdentity(memberCanonicalPath, memberStat)
          )
        ) {
          throw descriptorError('hosted-task-board-descriptor-directory-membership-invalid');
        }
      } finally {
        await member?.close().catch(() => undefined);
      }
    } else if (directory.name !== null) {
      throw descriptorError('hosted-task-board-descriptor-directory-membership-invalid');
    }
    assertActive(assertStillActive);
    const stat = await directory.handle.stat({ bigint: true });
    const canonicalPath = await fs.promises.realpath(descriptorPath(directory));
    assertActive(assertStillActive);
    const observed = directoryIdentity(canonicalPath, stat);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonicalPath !== directory.expectedPath ||
      !sameDirectoryIdentity(directory.identity, observed)
    ) {
      throw descriptorError('hosted-task-board-descriptor-directory-revalidation-failed');
    }
    validated.add(directory);
  };
  for (const directory of directories) {
    await verify(directory);
  }
}

export async function revalidateHostedTaskBoardSnapshots(
  directories: readonly HostedTaskBoardDirectoryDescriptor[],
  files: readonly HostedTaskBoardFileSnapshot[],
  assertStillActive?: () => void
): Promise<void> {
  await revalidateHostedTaskBoardDirectories(directories, assertStillActive);
  for (const file of files) {
    await revalidateHostedTaskBoardFile(file, assertStillActive);
  }
}

export async function listHostedTaskBoardDirectoryNames(
  directory: HostedTaskBoardDirectoryDescriptor,
  maximumEntries: number,
  assertStillActive?: () => void
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-entry-budget-invalid');
  }
  await revalidateHostedTaskBoardDirectories([directory], assertStillActive);
  const reader = await fs.promises.opendir(descriptorPath(directory));
  const names: string[] = [];
  try {
    for await (const entry of reader) {
      assertActive(assertStillActive);
      if (!validChildName(entry.name)) {
        throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-entry-invalid');
      }
      names.push(entry.name);
      if (names.length > maximumEntries) {
        throw descriptorError('hosted-task-board-descriptor-entry-budget-exceeded');
      }
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
  await revalidateHostedTaskBoardDirectories([directory], assertStillActive);
  return Object.freeze(names.sort((left, right) => left.localeCompare(right)));
}

export async function revalidateHostedTaskBoardDirectoryMembership(
  directory: HostedTaskBoardDirectoryDescriptor,
  expectedNames: readonly string[],
  maximumEntries: number,
  assertStillActive?: () => void
): Promise<void> {
  if (
    expectedNames.length > maximumEntries ||
    expectedNames.some((name) => !validChildName(name)) ||
    new Set(expectedNames).size !== expectedNames.length
  ) {
    throw descriptorError('hosted-task-board-descriptor-membership-input-invalid');
  }
  const expected = [...expectedNames].sort((left, right) => left.localeCompare(right));
  const actual = await listHostedTaskBoardDirectoryNames(
    directory,
    maximumEntries,
    assertStillActive
  );
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw descriptorError('hosted-task-board-descriptor-membership-revalidation-failed');
  }
}

export async function closeHostedTaskBoardDirectories(
  directories: readonly HostedTaskBoardDirectoryDescriptor[]
): Promise<void> {
  let failure: unknown;
  for (const directory of [...directories].reverse()) {
    try {
      await directory.handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-close-failed');
  }
}
