import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseTeamId, type TeamId } from '@shared/contracts/hosted/identifiers';

import {
  type LegacyTeamKey,
  type MarkerOwnedRootEvidence,
  parseLegacyTeamKey,
  parseTeamIdentityChecksum,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  TEAM_DIRECTORY_ROOT_MARKER_FILE,
  TEAM_IDENTITY_FILE_NAME,
  TEAM_IDENTITY_SCHEMA_VERSION,
  type TeamAttemptArtifactOwnership,
  type TeamAttemptArtifactOwnershipRegistry,
  type TeamDirectoryRootAdmission,
  type TeamIdentityAuthorityEvidence,
  type TeamIdentityAuthorityLookupOutcome,
  type TeamIdentityBlockReason,
  type TeamIdentityFile,
  type TeamIdentityIntent,
  type TeamIdentityPersistence,
  type TeamIdentityPublicationEvidence,
  type TeamIdentityPublicationPort,
  type TeamIdentityTombstoneOutcome,
} from '../../core/application/ports/TeamIdentityPersistence';

const ROOT_MARKER_MAX_BYTES = 2 * 1024;
const ATTEMPT_OWNERSHIP_MAX_BYTES = 4 * 1024;
const MARKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REMOVAL_QUARANTINE_DIRECTORY_NAME = '.p2-d-removal-quarantine';
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY ?? 0;
const PROTECTED_TEAM_ARTIFACTS = new Set([
  TEAM_IDENTITY_FILE_NAME,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  'config.json',
  'team.meta.json',
  'members.meta.json',
]);

interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface DirectoryBinding {
  readonly logicalPath: string;
  readonly canonicalPath: string;
  readonly identity: EntryIdentity;
  readonly handle: fs.promises.FileHandle;
  readonly descriptorPath: string | null;
}

interface AttemptArtifactBinding {
  readonly relativePath: string;
  readonly namespace: DirectoryBinding;
  readonly artifact: DirectoryBinding;
  readonly ownership: TeamAttemptArtifactOwnership;
}

interface ValidatedMarkerRoot {
  readonly canonicalPath: string;
  readonly identity: EntryIdentity;
}

export interface PrepareTeamDirectoryRequest {
  readonly intent: TeamIdentityIntent;
  readonly operationId: string;
}

export type PrepareTeamDirectoryOutcome =
  | { readonly status: 'created' | 'resumed'; readonly teamId: TeamId }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'legacy_key_conflict'
        | 'legacy_key_tombstoned'
        | 'persistence_mismatch'
        | 'root_not_admitted'
        | 'unsafe_team_directory';
    };

export interface PublishAndCommitTeamIdentityRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly identity: TeamIdentityFile;
}

export type PublishAndCommitTeamIdentityOutcome =
  | {
      readonly status: 'committed' | 'already_committed';
      readonly teamId: TeamId;
      readonly identityGeneration: number;
      readonly recovery: 'published_and_committed' | 'resumed_file_published' | 'already_committed';
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | TeamIdentityBlockReason
        | 'authority_not_durable'
        | 'commit_blocked'
        | 'intent_mismatch'
        | 'publication_not_durable';
    };

export interface AttemptOwnedArtifact {
  readonly relativePath: string;
  readonly ownerRunId: string;
}

export interface RegisterAttemptArtifactOwnershipRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly artifactRelativePath: string;
  readonly createdAt: string;
}

export type RegisterAttemptArtifactOwnershipOutcome =
  | { readonly status: 'registered' | 'already_registered'; readonly durability: 'durable' }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'artifact_not_pristine'
        | 'artifact_ownership_unproven'
        | 'identity_blocked'
        | 'root_not_admitted'
        | 'unsafe_attempt_path'
        | 'unsafe_team_directory';
    };

export interface CleanupProvisioningFailureRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly runId: string;
  readonly attemptOwnedArtifacts: readonly AttemptOwnedArtifact[];
}

export type CleanupProvisioningFailureOutcome =
  | {
      readonly status: 'cleaned';
      readonly removedArtifacts: readonly string[];
      readonly anchorPreserved: true;
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'artifact_ownership_mismatch'
        | 'artifact_ownership_unproven'
        | 'identity_blocked'
        | 'protected_artifact'
        | 'root_not_admitted'
        | 'unsafe_attempt_path'
        | 'unsafe_team_directory';
    };

export interface ExplicitTeamDeleteRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedIdentityGeneration: number;
  readonly confirmation: 'delete_draft' | 'permanent_delete';
  readonly requestedAt: string;
}

export interface AbortPreparedTeamDirectoryRequest {
  readonly teamId: TeamId;
  readonly legacyTeamKey: LegacyTeamKey;
  readonly expectedIdentityGeneration: number;
  readonly confirmation: 'prepared_abort';
  readonly requestedAt: string;
}

export type ExplicitTeamDeleteOutcome =
  | {
      readonly status: 'deleted' | 'already_deleted';
      readonly tombstoneGeneration: number;
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'delete_not_explicit'
        | 'filesystem_delete_failed'
        | 'identity_blocked'
        | 'root_not_admitted'
        | 'tombstone_not_durable'
        | 'unsafe_team_directory';
    };

class DirectoryBoundaryError extends Error {
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function mapPrepareBlockReason(
  reason: string
): Extract<PrepareTeamDirectoryOutcome, { status: 'blocked' }>['reason'] {
  if (reason === 'legacy_key_tombstoned') return 'legacy_key_tombstoned';
  if (reason === 'legacy_key_conflict') return 'legacy_key_conflict';
  return 'persistence_mismatch';
}

export function serializeTeamAttemptArtifactOwnership(
  ownership: TeamAttemptArtifactOwnership
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: 'p2-d-provisioning-attempt',
      teamId: ownership.teamId,
      legacyTeamKey: ownership.legacyTeamKey,
      runId: ownership.runId,
      artifactRelativePath: ownership.artifactRelativePath,
      createdAt: ownership.createdAt,
    } satisfies TeamAttemptArtifactOwnership,
    null,
    2
  )}\n`;
}

function parseTeamAttemptArtifactOwnership(
  raw: string,
  expected: Omit<TeamAttemptArtifactOwnership, 'schemaVersion' | 'scope' | 'createdAt'>
): TeamAttemptArtifactOwnership {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'artifactRelativePath',
    'createdAt',
    'legacyTeamKey',
    'runId',
    'schemaVersion',
    'scope',
    'teamId',
  ];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    record.scope !== 'p2-d-provisioning-attempt' ||
    record.teamId !== expected.teamId ||
    record.legacyTeamKey !== expected.legacyTeamKey ||
    record.runId !== expected.runId ||
    record.artifactRelativePath !== expected.artifactRelativePath ||
    !isCanonicalTimestamp(record.createdAt)
  ) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  try {
    const ownership: TeamAttemptArtifactOwnership = {
      schemaVersion: 1,
      scope: 'p2-d-provisioning-attempt',
      teamId: parseTeamId(record.teamId),
      legacyTeamKey: parseLegacyTeamKey(record.legacyTeamKey),
      runId: String(record.runId),
      artifactRelativePath: String(record.artifactRelativePath),
      createdAt: record.createdAt,
    };
    if (raw !== serializeTeamAttemptArtifactOwnership(ownership)) {
      throw new DirectoryBoundaryError('artifact_ownership_unproven');
    }
    return ownership;
  } catch (error) {
    if (error instanceof DirectoryBoundaryError) throw error;
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
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

async function assertCurrentDirectoryBinding(
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

async function childPathForMutation(
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

async function quarantineLogicalDirectory(
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

async function readBoundedFile(
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
  if (
    samePath(rootPath, canonicalTemporaryRoot) ||
    !isPathInside(rootPath, canonicalTemporaryRoot)
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

async function openAdmittedTeamsRoot(
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
  if (!isPathInside(teamsRootPath, runtimeRoot.canonicalPath)) {
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

async function openChildDirectory(
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

async function openTeamDirectory(
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

async function listNonQuarantineEntries(
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

function assertOperationId(value: string): void {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
}

function parseAttemptRelativePath(relativePath: string): readonly [string, string] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    PROTECTED_TEAM_ARTIFACTS.has(segments[0] ?? '') ||
    segments[0]?.startsWith('.identity-')
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
  return [segments[0] ?? '', segments[1] ?? ''];
}

function assertAttemptNamespace(segments: readonly [string, string], runId: string): void {
  const [namespace, namespaceRunId] = segments;
  if (
    (namespace !== 'attempts' && namespace !== '.provisioning-attempts') ||
    namespaceRunId !== runId
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
}

async function validateAttemptArtifactPath(
  teamDirectory: DirectoryBinding,
  request: CleanupProvisioningFailureRequest,
  artifact: AttemptOwnedArtifact
): Promise<AttemptArtifactBinding | null> {
  const segments = parseAttemptRelativePath(artifact.relativePath);
  assertAttemptNamespace(segments, request.runId);
  const namespace = await openChildDirectory(
    teamDirectory,
    segments[0],
    path.join(teamDirectory.logicalPath, segments[0]),
    true,
    'unsafe_attempt_path'
  );
  if (!namespace) return null;
  try {
    const artifactDirectory = await openChildDirectory(
      namespace,
      segments[1],
      path.join(namespace.logicalPath, segments[1]),
      true,
      'unsafe_attempt_path'
    );
    if (!artifactDirectory) {
      await namespace.handle.close();
      return null;
    }
    try {
      const provenance = await readBoundedFile(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        ATTEMPT_OWNERSHIP_MAX_BYTES,
        'artifact_ownership_unproven'
      );
      if (!provenance || (provenance.stat.mode & 0o077) !== 0) {
        throw new DirectoryBoundaryError('artifact_ownership_unproven');
      }
      const ownership = parseTeamAttemptArtifactOwnership(provenance.raw, {
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: artifact.relativePath,
      });
      return {
        relativePath: artifact.relativePath,
        namespace,
        artifact: artifactDirectory,
        ownership,
      };
    } catch (error) {
      await artifactDirectory.handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await namespace.handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateAttemptOwnership(
  binding: AttemptArtifactBinding,
  request: CleanupProvisioningFailureRequest
): Promise<void> {
  await assertCurrentDirectoryBinding(binding.namespace, 'unsafe_attempt_path');
  await assertCurrentDirectoryBinding(binding.artifact, 'unsafe_attempt_path');
  const provenance = await readBoundedFile(
    binding.artifact,
    TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
    ATTEMPT_OWNERSHIP_MAX_BYTES,
    'artifact_ownership_unproven'
  );
  if (!provenance || (provenance.stat.mode & 0o077) !== 0) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  const ownership = parseTeamAttemptArtifactOwnership(provenance.raw, {
    teamId: request.teamId,
    legacyTeamKey: request.legacyTeamKey,
    runId: request.runId,
    artifactRelativePath: binding.relativePath,
  });
  if (
    serializeTeamAttemptArtifactOwnership(ownership) !==
    serializeTeamAttemptArtifactOwnership(binding.ownership)
  ) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
}

async function closeAttemptBinding(binding: AttemptArtifactBinding): Promise<void> {
  await Promise.allSettled([binding.artifact.handle.close(), binding.namespace.handle.close()]);
}

function publicationMatchesAuthority(
  publication: TeamIdentityPublicationEvidence,
  authority: Extract<TeamIdentityAuthorityEvidence, { state: 'file_published' }>,
  intent: TeamIdentityIntent
): boolean {
  return (
    publication.teamId === intent.teamId &&
    publication.legacyTeamKey === intent.legacyTeamKey &&
    publication.checksum === intent.expectedChecksum &&
    publication.fileSchemaVersion === TEAM_IDENTITY_SCHEMA_VERSION &&
    isCanonicalTimestamp(publication.publishedAt) &&
    publication.fileFsync === 'synced' &&
    publication.parentDirectoryFsync === 'synced' &&
    authority.expectedChecksum === intent.expectedChecksum &&
    authority.publication.teamId === publication.teamId &&
    authority.publication.legacyTeamKey === publication.legacyTeamKey &&
    authority.publication.checksum === publication.checksum &&
    authority.publication.fileSchemaVersion === publication.fileSchemaVersion &&
    authority.publication.publishedAt === publication.publishedAt
  );
}

function sameAttemptOwnership(
  left: TeamAttemptArtifactOwnership,
  right: TeamAttemptArtifactOwnership
): boolean {
  return (
    serializeTeamAttemptArtifactOwnership(left) === serializeTeamAttemptArtifactOwnership(right)
  );
}

export class TeamDirectoryLifecycleAdapter {
  constructor(
    private readonly admission: TeamDirectoryRootAdmission,
    private readonly persistence: TeamIdentityPersistence,
    private readonly identityFiles: TeamIdentityPublicationPort,
    private readonly attemptOwnership: TeamAttemptArtifactOwnershipRegistry
  ) {}

  async prepareTeamDirectory(
    request: PrepareTeamDirectoryRequest
  ): Promise<PrepareTeamDirectoryOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let existing: DirectoryBinding | null = null;
    try {
      assertOperationId(request.operationId);
      parseTeamId(request.intent.teamId);
      parseLegacyTeamKey(request.intent.legacyTeamKey);
      parseTeamIdentityChecksum(request.intent.expectedChecksum);
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      existing = await openTeamDirectory(teamsRoot, request.intent.legacyTeamKey, true);
      const prepared = await this.persistence.prepare(request.intent);
      if (prepared.status === 'blocked') {
        return { status: 'blocked', reason: mapPrepareBlockReason(prepared.reason) };
      }
      if (prepared.intent.expectedChecksum !== request.intent.expectedChecksum) {
        return { status: 'blocked', reason: 'persistence_mismatch' };
      }
      if (existing) {
        if (prepared.status === 'already_prepared') {
          await assertCurrentDirectoryBinding(existing, 'unsafe_team_directory');
          await teamsRoot.handle.sync();
          return { status: 'resumed', teamId: request.intent.teamId };
        }
        return { status: 'blocked', reason: 'legacy_key_conflict' };
      }
      await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
      const targetPath = await childPathForMutation(
        teamsRoot,
        request.intent.legacyTeamKey,
        'unsafe_team_directory'
      );
      await fs.promises.mkdir(targetPath, { mode: 0o700 });
      const created = await openTeamDirectory(teamsRoot, request.intent.legacyTeamKey, false);
      if (!created) throw new DirectoryBoundaryError('unsafe_team_directory');
      try {
        await created.handle.sync();
        await teamsRoot.handle.sync();
        await assertCurrentDirectoryBinding(created, 'unsafe_team_directory');
      } finally {
        await created.handle.close();
      }
      return { status: 'created', teamId: request.intent.teamId };
    } catch (error) {
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError
            ? error.reason === 'root_not_admitted'
              ? 'root_not_admitted'
              : 'unsafe_team_directory'
            : 'unsafe_team_directory',
      };
    } finally {
      await existing?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async publishAndCommitIdentity(
    request: PublishAndCommitTeamIdentityRequest
  ): Promise<PublishAndCommitTeamIdentityOutcome> {
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
    } catch {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }
    if (request.identity.teamId !== request.teamId) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }

    const initial = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (initial.status === 'blocked') {
      return { status: 'blocked', reason: 'authority_not_durable' };
    }
    if (!this.intentMatchesRequest(initial.intent, request)) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }
    if (initial.authority.duplicateTeamIdCount > 0) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }

    if (initial.authority.state === 'tombstoned') {
      return { status: 'blocked', reason: 'identity_tombstoned' };
    }
    if (initial.authority.state === 'committed') {
      if (
        !Number.isSafeInteger(initial.authority.identityGeneration) ||
        initial.authority.identityGeneration < 1
      ) {
        return { status: 'blocked', reason: 'authority_not_durable' };
      }
      const inspected = await this.identityFiles.inspect(request.legacyTeamKey, initial.authority);
      if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
        return {
          status: 'blocked',
          reason: inspected.status === 'blocked' ? inspected.reason : 'identity_mismatch',
        };
      }
      return {
        status: 'already_committed',
        teamId: request.teamId,
        identityGeneration: initial.authority.identityGeneration,
        recovery: 'already_committed',
      };
    }

    let durable: TeamIdentityAuthorityLookupOutcome = initial;
    let recovery: 'published_and_committed' | 'resumed_file_published';
    if (initial.authority.state === 'prepared') {
      const published = await this.identityFiles.publish({
        legacyTeamKey: request.legacyTeamKey,
        identity: request.identity,
        authority: initial.authority,
      });
      if (published.status === 'blocked') {
        return { status: 'blocked', reason: published.reason };
      }
      const recorded = await this.persistence.recordPublication(published.evidence);
      if (recorded.status === 'blocked') {
        return { status: 'blocked', reason: 'publication_not_durable' };
      }
      durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked') {
        return { status: 'blocked', reason: 'publication_not_durable' };
      }
      recovery = 'published_and_committed';
    } else {
      recovery = 'resumed_file_published';
    }

    if (durable.authority.state === 'committed') {
      const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
        return { status: 'blocked', reason: 'commit_blocked' };
      }
      return {
        status: 'already_committed',
        teamId: request.teamId,
        identityGeneration: durable.authority.identityGeneration,
        recovery: 'already_committed',
      };
    }
    if (
      durable.authority.state !== 'file_published' ||
      !this.intentMatchesRequest(durable.intent, request) ||
      !publicationMatchesAuthority(durable.authority.publication, durable.authority, durable.intent)
    ) {
      return { status: 'blocked', reason: 'publication_not_durable' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'valid' || inspected.capability !== 'read_only') {
      return {
        status: 'blocked',
        reason: inspected.status === 'blocked' ? inspected.reason : 'identity_mismatch',
      };
    }
    const committed = await this.persistence.commit({
      intent: durable.intent,
      publication: durable.authority.publication,
    });
    if (
      committed.status === 'blocked' ||
      committed.teamId !== request.teamId ||
      committed.checksum !== durable.intent.expectedChecksum ||
      !Number.isSafeInteger(committed.identityGeneration) ||
      committed.identityGeneration < 1
    ) {
      return { status: 'blocked', reason: 'commit_blocked' };
    }
    return {
      status: committed.status,
      teamId: committed.teamId,
      identityGeneration: committed.identityGeneration,
      recovery,
    };
  }

  async registerAttemptArtifactOwnership(
    request: RegisterAttemptArtifactOwnershipRequest
  ): Promise<RegisterAttemptArtifactOwnershipOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    let namespace: DirectoryBinding | null = null;
    let artifactDirectory: DirectoryBinding | null = null;
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      assertOperationId(request.runId);
      if (!isCanonicalTimestamp(request.createdAt)) {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const segments = parseAttemptRelativePath(request.artifactRelativePath);
      assertAttemptNamespace(segments, request.runId);

      const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked' || durable.authority.state !== 'committed') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (identity.status !== 'valid' || identity.capability !== 'read_write') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }

      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, false);
      if (!teamDirectory) {
        return { status: 'blocked', reason: 'unsafe_team_directory' };
      }
      namespace = await openChildDirectory(
        teamDirectory,
        segments[0],
        path.join(teamDirectory.logicalPath, segments[0]),
        false,
        'unsafe_attempt_path'
      );
      if (!namespace) return { status: 'blocked', reason: 'unsafe_attempt_path' };
      artifactDirectory = await openChildDirectory(
        namespace,
        segments[1],
        path.join(namespace.logicalPath, segments[1]),
        false,
        'unsafe_attempt_path'
      );
      if (!artifactDirectory) return { status: 'blocked', reason: 'unsafe_attempt_path' };

      const expected: TeamAttemptArtifactOwnership = {
        schemaVersion: 1,
        scope: 'p2-d-provisioning-attempt',
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: request.artifactRelativePath,
        createdAt: request.createdAt,
      };
      let registered = await this.attemptOwnership.getAttemptArtifactOwnership({
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: request.artifactRelativePath,
      });
      if (registered.status === 'blocked') {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const existing = await readBoundedFile(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        ATTEMPT_OWNERSHIP_MAX_BYTES,
        'artifact_ownership_unproven'
      );
      if (existing) {
        if ((existing.stat.mode & 0o077) !== 0 || registered.status !== 'found') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        const parsed = parseTeamAttemptArtifactOwnership(existing.raw, {
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: request.artifactRelativePath,
        });
        if (
          parsed.createdAt !== request.createdAt ||
          !sameAttemptOwnership(parsed, registered.ownership)
        ) {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        return { status: 'already_registered', durability: 'durable' };
      }

      await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
      const entries = await listNonQuarantineEntries(artifactDirectory, 'unsafe_attempt_path');
      if (entries.length !== 0) {
        return { status: 'blocked', reason: 'artifact_not_pristine' };
      }
      const freshAuthority = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (
        freshAuthority.status === 'blocked' ||
        freshAuthority.authority.state !== 'committed' ||
        freshAuthority.authority.identityGeneration !== durable.authority.identityGeneration ||
        freshAuthority.authority.expectedChecksum !== durable.authority.expectedChecksum
      ) {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      if (registered.status === 'absent') {
        const recorded = await this.attemptOwnership.recordAttemptArtifactOwnership(expected);
        if (recorded.status === 'blocked' || recorded.durability !== 'durable') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: request.artifactRelativePath,
        });
      }
      if (registered.status !== 'found' || !sameAttemptOwnership(registered.ownership, expected)) {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const ownershipPath = await childPathForMutation(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        'unsafe_attempt_path'
      );
      const handle = await fs.promises.open(
        ownershipPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      try {
        await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
        await handle.writeFile(serializeTeamAttemptArtifactOwnership(expected), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await artifactDirectory.handle.sync();
      await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
      return { status: 'registered', durability: 'durable' };
    } catch (error) {
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError ? error.reason : 'artifact_ownership_unproven',
      };
    } finally {
      await artifactDirectory?.handle.close().catch(() => undefined);
      await namespace?.handle.close().catch(() => undefined);
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async cleanupProvisioningFailure(
    request: CleanupProvisioningFailureRequest
  ): Promise<CleanupProvisioningFailureOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    const validated: AttemptArtifactBinding[] = [];
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      assertOperationId(request.runId);
      const seenPaths = new Set<string>();
      for (const artifact of request.attemptOwnedArtifacts) {
        if (artifact.ownerRunId !== request.runId) {
          return { status: 'blocked', reason: 'artifact_ownership_mismatch' };
        }
        const firstSegment = artifact.relativePath.split('/')[0] ?? '';
        if (PROTECTED_TEAM_ARTIFACTS.has(firstSegment) || firstSegment.startsWith('.identity-')) {
          return { status: 'blocked', reason: 'protected_artifact' };
        }
        assertAttemptNamespace(parseAttemptRelativePath(artifact.relativePath), request.runId);
        if (seenPaths.has(artifact.relativePath)) {
          return { status: 'blocked', reason: 'artifact_ownership_mismatch' };
        }
        seenPaths.add(artifact.relativePath);
      }

      const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked' || durable.authority.state !== 'committed') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (identity.status !== 'valid' || identity.capability !== 'read_write') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, false);
      if (!teamDirectory) {
        return { status: 'blocked', reason: 'unsafe_team_directory' };
      }

      for (const artifact of request.attemptOwnedArtifacts) {
        const registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: artifact.relativePath,
        });
        if (registered.status !== 'found') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        const artifactBinding = await validateAttemptArtifactPath(teamDirectory, request, artifact);
        if (artifactBinding) {
          if (!sameAttemptOwnership(artifactBinding.ownership, registered.ownership)) {
            await closeAttemptBinding(artifactBinding);
            return { status: 'blocked', reason: 'artifact_ownership_unproven' };
          }
          validated.push(artifactBinding);
        }
      }

      const removedArtifacts: string[] = [];
      for (const binding of validated) {
        const freshAuthority = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
        if (
          freshAuthority.status === 'blocked' ||
          freshAuthority.authority.state !== 'committed' ||
          freshAuthority.authority.identityGeneration !== durable.authority.identityGeneration ||
          freshAuthority.authority.expectedChecksum !== durable.authority.expectedChecksum
        ) {
          throw new DirectoryBoundaryError('unsafe_team_directory');
        }
        const freshIdentity = await this.identityFiles.inspect(
          request.legacyTeamKey,
          freshAuthority.authority
        );
        if (freshIdentity.status !== 'valid' || freshIdentity.capability !== 'read_write') {
          throw new DirectoryBoundaryError('unsafe_team_directory');
        }
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        await revalidateAttemptOwnership(binding, request);
        const registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: binding.relativePath,
        });
        if (
          registered.status !== 'found' ||
          !sameAttemptOwnership(binding.ownership, registered.ownership)
        ) {
          throw new DirectoryBoundaryError('artifact_ownership_unproven');
        }
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        await assertCurrentDirectoryBinding(binding.artifact, 'unsafe_attempt_path');
        await quarantineLogicalDirectory(
          binding.namespace,
          request.runId,
          binding.artifact,
          'unsafe_attempt_path'
        );
        await teamDirectory.handle.sync();
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        removedArtifacts.push(binding.relativePath);
      }
      return { status: 'cleaned', removedArtifacts, anchorPreserved: true };
    } catch (error) {
      return {
        status: 'blocked',
        reason: error instanceof DirectoryBoundaryError ? error.reason : 'unsafe_team_directory',
      };
    } finally {
      await Promise.allSettled(validated.map(closeAttemptBinding));
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async deleteDraft(request: ExplicitTeamDeleteRequest): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'delete_draft') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    return this.deleteExplicitly(request);
  }

  async permanentlyDelete(request: ExplicitTeamDeleteRequest): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'permanent_delete') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    return this.deleteExplicitly(request);
  }

  async abortPreparedDirectory(
    request: AbortPreparedTeamDirectoryRequest
  ): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'prepared_abort') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (durable.status === 'blocked' || durable.authority.state !== 'prepared') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'absent') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    return this.deleteAfterTombstone(request, durable, 'prepared_abort');
  }

  private async deleteExplicitly(
    request: ExplicitTeamDeleteRequest
  ): Promise<ExplicitTeamDeleteOutcome> {
    const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (durable.status === 'blocked') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    if (durable.authority.state === 'tombstoned') {
      const directoryState = await this.inspectTeamDirectoryPresence(request.legacyTeamKey);
      if (directoryState !== 'absent') {
        return {
          status: 'blocked',
          reason: directoryState === 'blocked' ? 'unsafe_team_directory' : 'identity_blocked',
        };
      }
      return {
        status: 'already_deleted',
        tombstoneGeneration: durable.authority.tombstoneGeneration,
      };
    }
    if (
      durable.authority.state !== 'committed' ||
      durable.authority.identityGeneration !== request.expectedIdentityGeneration
    ) {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    return this.deleteAfterTombstone(request, durable, request.confirmation);
  }

  private async deleteAfterTombstone(
    request: ExplicitTeamDeleteRequest | AbortPreparedTeamDirectoryRequest,
    durable: Extract<TeamIdentityAuthorityLookupOutcome, { status: 'found' }>,
    reason: 'delete_draft' | 'permanent_delete' | 'prepared_abort'
  ): Promise<ExplicitTeamDeleteOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, true);
    } catch (error) {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError && error.reason === 'root_not_admitted'
            ? 'root_not_admitted'
            : 'unsafe_team_directory',
      };
    }

    const tombstone = await this.persistence
      .tombstone({
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        expectedIdentityGeneration: request.expectedIdentityGeneration,
        reason,
        requestedAt: request.requestedAt,
      })
      .catch(() => null);
    if (!tombstone || !this.isDurableTombstone(tombstone)) {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot.handle.close().catch(() => undefined);
      return { status: 'blocked', reason: 'tombstone_not_durable' };
    }
    if (!teamDirectory) {
      await teamsRoot.handle.close().catch(() => undefined);
      return {
        status: 'already_deleted',
        tombstoneGeneration: tombstone.tombstoneGeneration,
      };
    }

    try {
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (
        (durable.authority.state === 'committed' &&
          (identity.status !== 'valid' || identity.capability !== 'read_write')) ||
        (durable.authority.state === 'prepared' && identity.status !== 'absent')
      ) {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
      await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
      await quarantineLogicalDirectory(
        teamsRoot,
        request.legacyTeamKey,
        teamDirectory,
        'unsafe_team_directory'
      );
      return { status: 'deleted', tombstoneGeneration: tombstone.tombstoneGeneration };
    } catch {
      return { status: 'blocked', reason: 'filesystem_delete_failed' };
    } finally {
      await teamDirectory.handle.close().catch(() => undefined);
      await teamsRoot.handle.close().catch(() => undefined);
    }
  }

  private async lookupAuthority(
    teamId: TeamId,
    legacyTeamKey: LegacyTeamKey
  ): Promise<TeamIdentityAuthorityLookupOutcome> {
    const outcome = await this.persistence.getAuthority({ teamId, legacyTeamKey }).catch(() => ({
      status: 'blocked' as const,
      reason: 'identity_mismatch' as const,
    }));
    if (
      outcome.status === 'found' &&
      (outcome.intent.teamId !== teamId ||
        outcome.intent.legacyTeamKey !== legacyTeamKey ||
        outcome.authority.teamId !== teamId ||
        !Number.isSafeInteger(outcome.authority.duplicateTeamIdCount) ||
        outcome.authority.duplicateTeamIdCount < 0 ||
        (outcome.authority.expectedChecksum !== undefined &&
          outcome.authority.expectedChecksum !== outcome.intent.expectedChecksum))
    ) {
      return { status: 'blocked', reason: 'identity_mismatch' };
    }
    return outcome;
  }

  private async inspectTeamDirectoryPresence(
    legacyTeamKey: LegacyTeamKey
  ): Promise<'absent' | 'present' | 'blocked'> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    try {
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, legacyTeamKey, true);
      return teamDirectory ? 'present' : 'absent';
    } catch {
      return 'blocked';
    } finally {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  private intentMatchesRequest(
    intent: TeamIdentityIntent,
    request: PublishAndCommitTeamIdentityRequest
  ): boolean {
    return (
      intent.teamId === request.teamId &&
      intent.legacyTeamKey === request.legacyTeamKey &&
      intent.createdAt === request.identity.createdAt &&
      intent.originDeploymentId === request.identity.originDeploymentId
    );
  }

  private isDurableTombstone(
    outcome: TeamIdentityTombstoneOutcome
  ): outcome is Extract<TeamIdentityTombstoneOutcome, { durability: 'durable' }> {
    return (
      (outcome.status === 'tombstoned' || outcome.status === 'already_tombstoned') &&
      outcome.durability === 'durable'
    );
  }
}
