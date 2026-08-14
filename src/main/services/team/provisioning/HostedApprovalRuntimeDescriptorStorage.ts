import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const MAX_ADMISSION_BYTES = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9.][A-Za-z0-9._-]{0,190}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface TrustedDirectoryCapability {
  readonly handle: FileHandle;
  readonly identity: Readonly<{
    canonicalPath: string;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    mode: number;
  }>;
}

/** Opens, pins, and validates a private directory without following any path component alias. */
export async function openTrustedDirectoryCapability(
  expectedPath: string
): Promise<TrustedDirectoryCapability> {
  if (
    process.platform !== 'linux' ||
    !isAbsolute(expectedPath) ||
    normalize(expectedPath) !== expectedPath ||
    resolve(expectedPath) !== expectedPath ||
    expectedPath.includes('\0')
  ) {
    throw new Error('hosted-approval-runtime-directory-path-invalid');
  }
  const { open, realpath } = await import('node:fs/promises');
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      expectedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
    );
    const stat = await handle.stat();
    const canonicalPath = await realpath(`/proc/self/fd/${handle.fd}`);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.ino === 0 ||
      canonicalPath !== expectedPath ||
      (stat.mode & 0o777) !== DIRECTORY_MODE ||
      (uid !== undefined && stat.uid !== uid) ||
      (gid !== undefined && stat.gid !== gid)
    ) {
      throw new Error('hosted-approval-runtime-directory-capability-invalid');
    }
    const capability = Object.freeze({
      handle,
      identity: Object.freeze({
        canonicalPath,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode & 0o777,
      }),
    });
    handle = null;
    return capability;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateTrustedDirectoryCapability(
  capability: TrustedDirectoryCapability
): Promise<void> {
  const { realpath } = await import('node:fs/promises');
  const [stat, canonicalPath] = await Promise.all([
    capability.handle.stat(),
    realpath(`/proc/self/fd/${capability.handle.fd}`),
  ]);
  if (
    !stat.isDirectory() ||
    stat.dev !== capability.identity.dev ||
    stat.ino === 0 ||
    stat.ino !== capability.identity.ino ||
    stat.uid !== capability.identity.uid ||
    stat.gid !== capability.identity.gid ||
    (stat.mode & 0o777) !== capability.identity.mode ||
    capability.identity.mode !== DIRECTORY_MODE ||
    canonicalPath !== capability.identity.canonicalPath
  ) {
    throw new Error('hosted-approval-runtime-directory-capability-invalid');
  }
}

export async function descriptorAnchoredRead(
  directory: TrustedDirectoryCapability,
  name: string,
  options: Readonly<{ afterReadBeforeMembershipCheck?: () => Promise<void> }> = {}
): Promise<string | null> {
  await validateTrustedDirectoryCapability(directory);
  const { open } = await import('node:fs/promises');
  let file: FileHandle;
  try {
    file = await open(
      descriptorPath(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await file.stat();
    assertTrustedFile(before, directory, MAX_ADMISSION_BYTES);
    const body = await readBounded(file);
    if ((await readBounded(file)) !== body) {
      throw new Error('hosted-approval-runtime-file-changed');
    }
    const after = await file.stat();
    if (!sameIdentity(before, after) || Buffer.byteLength(body) !== after.size) {
      throw new Error('hosted-approval-runtime-file-changed');
    }
    await options.afterReadBeforeMembershipCheck?.();
    await assertPathNamesOpenFile(directory, name, after);
    await assertDirectoryUnchanged(directory);
    return body;
  } finally {
    await file.close();
  }
}

export async function descriptorAnchoredReplace(
  directory: TrustedDirectoryCapability,
  name: string,
  body: string,
  options: Readonly<{
    beforeRename: () => Promise<void>;
    /** Test-only adversarial seam after authority validation and before source membership proof. */
    beforeSourceMembershipCheck?: (temporaryPath: string) => Promise<void>;
  }>
): Promise<void> {
  await validateTrustedDirectoryCapability(directory);
  if (Buffer.byteLength(body) > MAX_ADMISSION_BYTES) {
    throw new Error('hosted-approval-runtime-file-oversize');
  }
  const temporaryName = `.hosted-approval-${randomUUID()}.tmp`;
  const { open, rename, unlink } = await import('node:fs/promises');
  const temporaryPath = descriptorPath(directory, temporaryName);
  const targetPath = descriptorPath(directory, name);
  const targetIdentity = await trustedTargetIdentity(directory, targetPath);
  let temporary: FileHandle | null = null;
  try {
    temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE
    );
    assertTrustedFile(await temporary.stat(), directory, MAX_ADMISSION_BYTES);
    await temporary.writeFile(body, 'utf8');
    await temporary.sync();
    const temporaryIdentity = await temporary.stat();
    assertTrustedFile(temporaryIdentity, directory, MAX_ADMISSION_BYTES);
    await options.beforeRename();
    await options.beforeSourceMembershipCheck?.(temporaryPath);
    await assertDirectoryUnchanged(directory);
    await assertTargetUnchanged(directory, targetPath, targetIdentity);
    await assertPathNamesOpenFile(directory, temporaryName, temporaryIdentity);
    await rename(temporaryPath, targetPath);
    await directory.handle.sync();
    await assertPathNamesOpenFile(directory, name, temporaryIdentity);
    const published = await descriptorAnchoredRead(directory, name);
    if (published !== body) {
      throw new Error('hosted-approval-runtime-publication-readback-invalid');
    }
    await temporary.close();
    temporary = null;
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface TrustedTargetIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

async function trustedTargetIdentity(
  directory: TrustedDirectoryCapability,
  targetPath: string
): Promise<TrustedTargetIdentity | null> {
  const { lstat } = await import('node:fs/promises');
  try {
    const stat = await lstat(targetPath, { bigint: true });
    assertTrustedFileBigInt(stat, directory, MAX_ADMISSION_BYTES);
    return Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertTargetUnchanged(
  directory: TrustedDirectoryCapability,
  targetPath: string,
  expected: TrustedTargetIdentity | null
): Promise<void> {
  const actual = await trustedTargetIdentity(directory, targetPath);
  if (
    (expected === null) !== (actual === null) ||
    (expected !== null &&
      actual !== null &&
      (expected.dev !== actual.dev ||
        expected.ino !== actual.ino ||
        expected.size !== actual.size ||
        expected.mtimeNs !== actual.mtimeNs ||
        expected.ctimeNs !== actual.ctimeNs))
  ) {
    throw new Error('hosted-approval-runtime-target-changed');
  }
}

export async function descriptorAnchoredUnlink(
  directory: TrustedDirectoryCapability,
  name: string
): Promise<boolean> {
  await validateTrustedDirectoryCapability(directory);
  const { unlink } = await import('node:fs/promises');
  let removed = true;
  try {
    await unlink(descriptorPath(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    removed = false;
  }
  await directory.handle.sync();
  const { lstat } = await import('node:fs/promises');
  try {
    await lstat(descriptorPath(directory, name));
    throw new Error('hosted-approval-runtime-revocation-unconfirmed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await assertDirectoryUnchanged(directory);
  return removed;
}

async function assertPathNamesOpenFile(
  directory: TrustedDirectoryCapability,
  name: string,
  opened: Stats
): Promise<void> {
  const { lstat } = await import('node:fs/promises');
  let membership: Stats;
  try {
    membership = await lstat(descriptorPath(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('hosted-approval-runtime-file-membership-changed', { cause: error });
    }
    throw error;
  }
  assertTrustedFile(membership, directory, MAX_ADMISSION_BYTES);
  if (membership.dev !== opened.dev || membership.ino === 0 || membership.ino !== opened.ino) {
    throw new Error('hosted-approval-runtime-file-membership-changed');
  }
}

function descriptorPath(directory: TrustedDirectoryCapability, name: string): string {
  if (process.platform !== 'linux' || !SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('hosted-approval-runtime-descriptor-storage-unavailable');
  }
  return `/proc/self/fd/${directory.handle.fd}/${name}`;
}

async function assertDirectoryUnchanged(directory: TrustedDirectoryCapability): Promise<void> {
  await validateTrustedDirectoryCapability(directory);
}

function assertTrustedFile(
  stat: Stats,
  directory: TrustedDirectoryCapability,
  maximumBytes: number
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== directory.identity.uid ||
    stat.gid !== directory.identity.gid ||
    (stat.mode & 0o777) !== FILE_MODE ||
    stat.size < 0 ||
    stat.size > maximumBytes
  ) {
    throw new Error('hosted-approval-runtime-file-invalid');
  }
}

function assertTrustedFileBigInt(
  stat: import('node:fs').BigIntStats,
  directory: TrustedDirectoryCapability,
  maximumBytes: number
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(directory.identity.uid) ||
    stat.gid !== BigInt(directory.identity.gid) ||
    (stat.mode & 0o777n) !== BigInt(FILE_MODE) ||
    stat.size < 0n ||
    stat.size > BigInt(maximumBytes)
  ) {
    throw new Error('hosted-approval-runtime-file-invalid');
  }
}

async function readBounded(file: FileHandle): Promise<string> {
  const bytes = Buffer.allocUnsafe(MAX_ADMISSION_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_ADMISSION_BYTES) {
    throw new Error('hosted-approval-runtime-file-oversize');
  }
  return bytes.subarray(0, offset).toString('utf8');
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino !== 0 &&
    left.ino === right.ino &&
    left.nlink === 1 &&
    right.nlink === 1 &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
