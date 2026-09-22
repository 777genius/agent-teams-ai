import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type LegacyTeamKey,
  type MarkerOwnedRootEvidence,
  parseLegacyTeamKey,
  TEAM_DIRECTORY_ROOT_MARKER_FILE,
  type TeamDirectoryRootAdmission,
} from '../../core/application/ports/TeamIdentityPersistence';

const ROOT_MARKER_MAX_BYTES = 2 * 1024;
const MARKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const REMOVAL_QUARANTINE_DIRECTORY_NAME = '.p2-d-removal-quarantine';
export const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY ?? 0;

export interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface DirectoryBinding {
  readonly logicalPath: string;
  readonly canonicalPath: string;
  readonly identity: EntryIdentity;
  readonly handle: fs.promises.FileHandle;
  readonly descriptorPath: string | null;
}

interface ValidatedMarkerRoot {
  readonly canonicalPath: string;
  readonly identity: EntryIdentity;
}

export class DirectoryBoundaryError extends Error {
  constructor(
    readonly reason:
      | 'artifact_ownership_unproven'
      | 'root_not_admitted'
      | 'unsafe_team_directory'
      | 'unsafe_attempt_path'
  ) {
    super(`team-directory-lifecycle:${reason}`);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isRemovalQuarantineName(entryName: string): boolean {
  return entryName === REMOVAL_QUARANTINE_DIRECTORY_NAME;
}

function entryIdentity(stat: fs.Stats): EntryIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameEntry(stat: fs.Stats, expected: EntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function stableFileStat(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readAtMost(handle: fs.promises.FileHandle, maxBytes: number): Promise<Buffer> {
  const capacity = maxBytes + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let offset = 0;
  while (offset < capacity) {
    const { bytesRead } = await handle.read(buffer, offset, capacity - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function descriptorPathFor(handle: fs.promises.FileHandle): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const candidate = path.join('/proc/self/fd', String(handle.fd));
  const [descriptorStat, handleStat] = await Promise.all([
    fs.promises.stat(candidate).catch(() => null),
    handle.stat().catch(() => null),
  ]);
  if (!descriptorStat || !handleStat || !sameEntry(descriptorStat, entryIdentity(handleStat))) {
    return null;
  }
  return candidate;
}

async function openDirectoryBinding(
  targetPath: string,
  logicalPath: string,
  reason: DirectoryBoundaryError['reason']
): Promise<DirectoryBinding> {
  const before = await fs.promises.lstat(targetPath).catch(() => null);
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    throw new DirectoryBoundaryError(reason);
  }
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(targetPath, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameEntry(opened, entryIdentity(before))) {
      throw new DirectoryBoundaryError(reason);
    }
    const binding: DirectoryBinding = {
      logicalPath,
      canonicalPath: await fs.promises.realpath(targetPath),
      identity: entryIdentity(opened),
      handle,
      descriptorPath: await descriptorPathFor(handle),
    };
    await assertCurrentDirectoryBinding(binding, reason);
    handle = null;
    return binding;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function assertCurrentDirectoryBinding(
  binding: DirectoryBinding,
  reason: DirectoryBoundaryError['reason']
): Promise<void> {
  const current = await fs.promises.lstat(binding.logicalPath).catch(() => null);
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !sameEntry(current, binding.identity)
  ) {
    throw new DirectoryBoundaryError(reason);
  }
  const [canonical, opened] = await Promise.all([
    fs.promises.realpath(binding.logicalPath).catch(() => null),
    binding.handle.stat().catch(() => null),
  ]);
  if (
    !canonical ||
    !opened?.isDirectory() ||
    !sameEntry(opened, binding.identity) ||
    !samePath(canonical, binding.canonicalPath)
  ) {
    throw new DirectoryBoundaryError(reason);
  }
}

export async function childPathForMutation(
  parent: DirectoryBinding,
  childName: string,
  reason: DirectoryBoundaryError['reason']
): Promise<string> {
  await assertCurrentDirectoryBinding(parent, reason);
  return path.join(parent.descriptorPath ?? parent.logicalPath, childName);
}

async function assertQuarantinedDirectoryBinding(
  parent: DirectoryBinding,
  quarantineContainer: DirectoryBinding,
  originalPath: string,
  quarantinePath: string,
  expected: DirectoryBinding,
  reason: DirectoryBoundaryError['reason']
): Promise<void> {
  await assertCurrentDirectoryBinding(parent, reason);
  await assertCurrentDirectoryBinding(quarantineContainer, reason);
  const [original, moved, opened, canonical] = await Promise.all([
    fs.promises.lstat(originalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
    fs.promises.lstat(quarantinePath).catch(() => null),
    expected.handle.stat().catch(() => null),
    fs.promises.realpath(quarantinePath).catch(() => null),
  ]);
  if (
    original !== null ||
    !moved?.isDirectory() ||
    moved.isSymbolicLink() ||
    !sameEntry(moved, expected.identity) ||
    !opened?.isDirectory() ||
    !sameEntry(opened, expected.identity) ||
    !canonical ||
    !isPathInside(quarantineContainer.canonicalPath, parent.canonicalPath) ||
    !isPathInside(canonical, quarantineContainer.canonicalPath)
  ) {
    throw new DirectoryBoundaryError(reason);
  }
}

async function openRemovalQuarantineContainer(
  parent: DirectoryBinding,
  reason: DirectoryBoundaryError['reason']
): Promise<DirectoryBinding> {
  await assertCurrentDirectoryBinding(parent, reason);
  const quarantineContainerPath = await childPathForMutation(
    parent,
    REMOVAL_QUARANTINE_DIRECTORY_NAME,
    reason
  );
  let created = false;
  try {
    await fs.promises.mkdir(quarantineContainerPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const quarantineContainer = await openChildDirectory(
    parent,
    REMOVAL_QUARANTINE_DIRECTORY_NAME,
    path.join(parent.logicalPath, REMOVAL_QUARANTINE_DIRECTORY_NAME),
    false,
    reason
  );
  if (!quarantineContainer) {
    throw new DirectoryBoundaryError(reason);
  }
  try {
    const stat = await quarantineContainer.handle.stat();
    if ((stat.mode & 0o077) !== 0) {
      throw new DirectoryBoundaryError(reason);
    }
    await assertCurrentDirectoryBinding(parent, reason);
    await assertCurrentDirectoryBinding(quarantineContainer, reason);
    if (created) {
      await quarantineContainer.handle.sync();
      await parent.handle.sync();
      await assertCurrentDirectoryBinding(parent, reason);
      await assertCurrentDirectoryBinding(quarantineContainer, reason);
    }
    return quarantineContainer;
  } catch (error) {
    await quarantineContainer.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function quarantineLogicalDirectory(
  parent: DirectoryBinding,
  leafName: string,
  expected: DirectoryBinding,
  reason: DirectoryBoundaryError['reason']
): Promise<void> {
  if (
    leafName.length === 0 ||
    leafName === '.' ||
    leafName === '..' ||
    path.basename(leafName) !== leafName
  ) {
    throw new DirectoryBoundaryError(reason);
  }
  let quarantineContainer: DirectoryBinding | null = null;
  try {
    await assertCurrentDirectoryBinding(parent, reason);
    await assertCurrentDirectoryBinding(expected, reason);
    const originalPath = await childPathForMutation(parent, leafName, reason);
    const original = await fs.promises.lstat(originalPath).catch(() => null);
    if (
      !original?.isDirectory() ||
      original.isSymbolicLink() ||
      !sameEntry(original, expected.identity)
    ) {
      throw new DirectoryBoundaryError(reason);
    }

    quarantineContainer = await openRemovalQuarantineContainer(parent, reason);
    const quarantineEntryName = randomUUID();
    const quarantinePath = await childPathForMutation(
      quarantineContainer,
      quarantineEntryName,
      reason
    );
    const collision = await fs.promises
      .lstat(quarantinePath)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (collision) throw new DirectoryBoundaryError(reason);

    await fs.promises.rename(originalPath, quarantinePath);
    await assertQuarantinedDirectoryBinding(
      parent,
      quarantineContainer,
      originalPath,
      quarantinePath,
      expected,
      reason
    );
    await quarantineContainer.handle.sync();
    await parent.handle.sync();
    await assertQuarantinedDirectoryBinding(
      parent,
      quarantineContainer,
      originalPath,
      quarantinePath,
      expected,
      reason
    );
    // The request path ends at durable logical removal. Physical quarantine retention and GC are
    // hosted-operations concerns because POSIX final-name checks cannot make a later unlink safe
    // against a same-UID name swap from another process.
  } finally {
    await quarantineContainer?.handle.close().catch(() => undefined);
  }
}

export async function readBoundedFile(
  parent: DirectoryBinding,
  childName: string,
  maxBytes: number,
  reason: DirectoryBoundaryError['reason']
): Promise<{ readonly raw: string; readonly stat: fs.Stats } | null> {
  const targetPath = await childPathForMutation(parent, childName, reason);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(targetPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new DirectoryBoundaryError(reason);
    }
    await assertCurrentDirectoryBinding(parent, reason);
    const bytes = await readAtMost(handle, maxBytes);
    const after = await handle.stat();
    await assertCurrentDirectoryBinding(parent, reason);
    if (bytes.byteLength > maxBytes || after.size > maxBytes || !stableFileStat(before, after)) {
      throw new DirectoryBoundaryError(reason);
    }
    return { raw: bytes.toString('utf8'), stat: after };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateMarkerRoot(
  evidence: MarkerOwnedRootEvidence,
  canonicalTemporaryRoot: string
): Promise<ValidatedMarkerRoot> {
  if (
    !path.isAbsolute(evidence.rootPath) ||
    !path.isAbsolute(evidence.canonicalRootPath) ||
    !MARKER_TOKEN_PATTERN.test(evidence.markerToken)
  ) {
    throw new DirectoryBoundaryError('root_not_admitted');
  }
  const rootPath = path.resolve(evidence.rootPath);
  // Fail-fast containment uses the caller's canonical path: the logical root may sit behind a
  // symlinked temp dir (macOS /var -> /private/var). The descriptor-bound check below re-derives
  // the real canonical path and stays authoritative against spoofed evidence.
  const canonicalRootPath = path.resolve(evidence.canonicalRootPath);
  if (
    samePath(canonicalRootPath, canonicalTemporaryRoot) ||
    !isPathInside(canonicalRootPath, canonicalTemporaryRoot)
  ) {
    throw new DirectoryBoundaryError('root_not_admitted');
  }
  const root = await openDirectoryBinding(rootPath, rootPath, 'root_not_admitted');
  try {
    if (
      !samePath(root.canonicalPath, path.resolve(evidence.canonicalRootPath)) ||
      !isPathInside(root.canonicalPath, canonicalTemporaryRoot)
    ) {
      throw new DirectoryBoundaryError('root_not_admitted');
    }
    const marker = await readBoundedFile(
      root,
      TEAM_DIRECTORY_ROOT_MARKER_FILE,
      ROOT_MARKER_MAX_BYTES,
      'root_not_admitted'
    );
    if (!marker || (marker.stat.mode & 0o077) !== 0) {
      throw new DirectoryBoundaryError('root_not_admitted');
    }
    const value = JSON.parse(marker.raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.scope !== 'p2-d-team-directory' ||
      value.kind !== evidence.kind ||
      value.ownershipToken !== evidence.markerToken ||
      Object.keys(value).length !== 4
    ) {
      throw new DirectoryBoundaryError('root_not_admitted');
    }
    return { canonicalPath: root.canonicalPath, identity: root.identity };
  } catch (error) {
    if (error instanceof DirectoryBoundaryError) throw error;
    throw new DirectoryBoundaryError('root_not_admitted');
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

export async function openAdmittedTeamsRoot(
  admission: TeamDirectoryRootAdmission
): Promise<DirectoryBinding> {
  const canonicalTemporaryRoot = await fs.promises.realpath(os.tmpdir());
  const [projectRoot, runtimeRoot] = await Promise.all([
    validateMarkerRoot(admission.projectRoot, canonicalTemporaryRoot),
    validateMarkerRoot(admission.runtimeRoot, canonicalTemporaryRoot),
  ]);
  if (
    samePath(projectRoot.canonicalPath, runtimeRoot.canonicalPath) ||
    !path.isAbsolute(admission.teamsRootPath)
  ) {
    throw new DirectoryBoundaryError('root_not_admitted');
  }
  const teamsRootPath = path.resolve(admission.teamsRootPath);
  // Fail-fast: the caller may address the teams root through the logical runtime root (which can
  // sit behind a symlinked temp dir, e.g. macOS /var -> /private/var). The descriptor-bound
  // canonical containment check below remains authoritative.
  if (
    !isPathInside(teamsRootPath, path.resolve(admission.runtimeRoot.rootPath)) &&
    !isPathInside(teamsRootPath, runtimeRoot.canonicalPath)
  ) {
    throw new DirectoryBoundaryError('root_not_admitted');
  }
  const teamsRoot = await openDirectoryBinding(teamsRootPath, teamsRootPath, 'root_not_admitted');
  if (!isPathInside(teamsRoot.canonicalPath, runtimeRoot.canonicalPath)) {
    await teamsRoot.handle.close().catch(() => undefined);
    throw new DirectoryBoundaryError('root_not_admitted');
  }
  try {
    const [freshProjectRoot, freshRuntimeRoot] = await Promise.all([
      validateMarkerRoot(admission.projectRoot, canonicalTemporaryRoot),
      validateMarkerRoot(admission.runtimeRoot, canonicalTemporaryRoot),
    ]);
    if (
      freshProjectRoot.identity.device !== projectRoot.identity.device ||
      freshProjectRoot.identity.inode !== projectRoot.identity.inode ||
      freshRuntimeRoot.identity.device !== runtimeRoot.identity.device ||
      freshRuntimeRoot.identity.inode !== runtimeRoot.identity.inode
    ) {
      throw new DirectoryBoundaryError('root_not_admitted');
    }
    await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
  } catch (error) {
    await teamsRoot.handle.close().catch(() => undefined);
    throw error;
  }
  return teamsRoot;
}

export async function openChildDirectory(
  parent: DirectoryBinding,
  childName: string,
  logicalPath: string,
  allowMissing: boolean,
  reason: DirectoryBoundaryError['reason']
): Promise<DirectoryBinding | null> {
  const targetPath = await childPathForMutation(parent, childName, reason);
  const target = await fs.promises.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!target) {
    if (allowMissing) return null;
    throw new DirectoryBoundaryError(reason);
  }
  const binding = await openDirectoryBinding(targetPath, logicalPath, reason);
  if (!isPathInside(binding.canonicalPath, parent.canonicalPath)) {
    await binding.handle.close().catch(() => undefined);
    throw new DirectoryBoundaryError(reason);
  }
  await assertCurrentDirectoryBinding(parent, reason);
  return binding;
}

export async function openTeamDirectory(
  teamsRoot: DirectoryBinding,
  legacyTeamKey: LegacyTeamKey,
  allowMissing: boolean
): Promise<DirectoryBinding | null> {
  parseLegacyTeamKey(legacyTeamKey);
  return openChildDirectory(
    teamsRoot,
    legacyTeamKey,
    path.join(teamsRoot.logicalPath, legacyTeamKey),
    allowMissing,
    'unsafe_team_directory'
  );
}

export async function listNonQuarantineEntries(
  parent: DirectoryBinding,
  reason: DirectoryBoundaryError['reason']
): Promise<readonly string[]> {
  await assertCurrentDirectoryBinding(parent, reason);
  const entries = await fs.promises.readdir(parent.descriptorPath ?? parent.logicalPath, {
    withFileTypes: true,
  });
  const visibleEntries: string[] = [];
  for (const entry of entries) {
    if (!isRemovalQuarantineName(entry.name)) {
      visibleEntries.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new DirectoryBoundaryError(reason);
    }
    const quarantineContainer = await openChildDirectory(
      parent,
      REMOVAL_QUARANTINE_DIRECTORY_NAME,
      path.join(parent.logicalPath, REMOVAL_QUARANTINE_DIRECTORY_NAME),
      false,
      reason
    );
    if (!quarantineContainer) {
      throw new DirectoryBoundaryError(reason);
    }
    try {
      const stat = await quarantineContainer.handle.stat();
      if ((stat.mode & 0o077) !== 0) {
        throw new DirectoryBoundaryError(reason);
      }
      await assertCurrentDirectoryBinding(quarantineContainer, reason);
    } finally {
      await quarantineContainer.handle.close().catch(() => undefined);
    }
  }
  await assertCurrentDirectoryBinding(parent, reason);
  return visibleEntries;
}
