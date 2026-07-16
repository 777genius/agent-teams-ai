import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseDeploymentId, parseTeamId } from '@shared/contracts/hosted/identifiers';

import {
  type LegacyTeamKey,
  type MarkerOwnedRootEvidence,
  parseLegacyTeamKey,
  parseTeamIdentityChecksum,
  TEAM_DIRECTORY_ROOT_MARKER_FILE,
  TEAM_IDENTITY_FILE_NAME,
  TEAM_IDENTITY_SCHEMA_VERSION,
  type TeamDirectoryRootAdmission,
  type TeamIdentityAuthorityEvidence,
  type TeamIdentityBlockReason,
  type TeamIdentityChecksum,
  type TeamIdentityFile,
  type TeamIdentityPublicationEvidence,
  type TeamIdentityPublicationPort,
  type TeamIdentityPublishOutcome,
  type TeamIdentityPublishRequest,
  type TeamIdentityReadOutcome,
} from '../../core/application/ports/TeamIdentityPersistence';

const MAX_IDENTITY_FILE_BYTES = 4 * 1024;
const MAX_ROOT_MARKER_BYTES = 2 * 1024;
const MARKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY ?? 0;

interface TeamDirectoryRootMarker {
  readonly schemaVersion: 1;
  readonly scope: 'p2-d-team-directory';
  readonly kind: 'project' | 'runtime';
  readonly ownershipToken: string;
}

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

interface ResolvedTeamDirectory {
  readonly teamsRoot: DirectoryBinding;
  readonly teamDirectory: DirectoryBinding;
}

interface ValidatedMarkerRoot {
  readonly canonicalPath: string;
  readonly identity: EntryIdentity;
}

class IdentityStoreBoundaryError extends Error {
  constructor(readonly reason: TeamIdentityBlockReason) {
    super(`team-identity-file-store:${reason}`);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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

function asBoundaryReason(error: unknown): TeamIdentityBlockReason {
  return error instanceof IdentityStoreBoundaryError ? error.reason : 'root_not_admitted';
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hasExactIdentityKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expected =
    value.originDeploymentId === undefined
      ? ['createdAt', 'schemaVersion', 'teamId']
      : ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId'];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseIdentityFile(raw: string): TeamIdentityFile | TeamIdentityBlockReason {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'corrupt_identity';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'corrupt_identity';
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.schemaVersion === 'number' &&
    record.schemaVersion > TEAM_IDENTITY_SCHEMA_VERSION
  ) {
    return 'future_identity';
  }
  if (record.schemaVersion !== TEAM_IDENTITY_SCHEMA_VERSION || !hasExactIdentityKeys(record)) {
    return 'corrupt_identity';
  }
  if (!isCanonicalTimestamp(record.createdAt)) {
    return 'corrupt_identity';
  }

  try {
    const identity: TeamIdentityFile = {
      schemaVersion: TEAM_IDENTITY_SCHEMA_VERSION,
      teamId: parseTeamId(record.teamId),
      createdAt: record.createdAt,
    };
    if (record.originDeploymentId !== undefined) {
      return {
        ...identity,
        originDeploymentId: parseDeploymentId(record.originDeploymentId),
      };
    }
    return identity;
  } catch {
    return 'corrupt_identity';
  }
}

export function serializeTeamIdentityFile(identity: TeamIdentityFile): string {
  const record: Record<string, unknown> = {
    schemaVersion: TEAM_IDENTITY_SCHEMA_VERSION,
    teamId: identity.teamId,
    createdAt: identity.createdAt,
  };
  if (identity.originDeploymentId !== undefined) {
    record.originDeploymentId = identity.originDeploymentId;
  }
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function checksumTeamIdentityFile(identity: TeamIdentityFile): TeamIdentityChecksum {
  return parseTeamIdentityChecksum(
    createHash('sha256').update(serializeTeamIdentityFile(identity), 'utf8').digest('hex')
  );
}

export function serializeTeamDirectoryRootMarker(
  kind: TeamDirectoryRootMarker['kind'],
  ownershipToken: string
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: 'p2-d-team-directory',
      kind,
      ownershipToken,
    } satisfies TeamDirectoryRootMarker,
    null,
    2
  )}\n`;
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
  reason: TeamIdentityBlockReason
): Promise<DirectoryBinding> {
  const before = await fs.promises.lstat(targetPath).catch(() => null);
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    throw new IdentityStoreBoundaryError(reason);
  }

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(targetPath, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameEntry(opened, entryIdentity(before))) {
      throw new IdentityStoreBoundaryError(reason);
    }
    const canonicalPath = await fs.promises.realpath(targetPath);
    const binding: DirectoryBinding = {
      logicalPath,
      canonicalPath,
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
  reason: TeamIdentityBlockReason
): Promise<void> {
  const current = await fs.promises.lstat(binding.logicalPath).catch(() => null);
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    !sameEntry(current, binding.identity)
  ) {
    throw new IdentityStoreBoundaryError(reason);
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
    throw new IdentityStoreBoundaryError(reason);
  }
}

async function childPathForMutation(
  parent: DirectoryBinding,
  childName: string,
  reason: TeamIdentityBlockReason
): Promise<string> {
  await assertCurrentDirectoryBinding(parent, reason);
  return path.join(parent.descriptorPath ?? parent.logicalPath, childName);
}

async function readBoundedFile(
  parent: DirectoryBinding,
  childName: string,
  maxBytes: number,
  reason: TeamIdentityBlockReason
): Promise<{ readonly raw: string; readonly stat: fs.Stats } | null> {
  const targetPath = await childPathForMutation(parent, childName, reason);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(targetPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new IdentityStoreBoundaryError(reason);
    }
    await assertCurrentDirectoryBinding(parent, reason);
    const bytes = await readAtMost(handle, maxBytes);
    const after = await handle.stat();
    await assertCurrentDirectoryBinding(parent, reason);
    if (bytes.byteLength > maxBytes || after.size > maxBytes || !stableFileStat(before, after)) {
      throw new IdentityStoreBoundaryError(reason);
    }
    return { raw: bytes.toString('utf8'), stat: after };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertMarkerOwnedRoot(
  evidence: MarkerOwnedRootEvidence,
  canonicalTemporaryRoot: string
): Promise<ValidatedMarkerRoot> {
  if (
    !path.isAbsolute(evidence.rootPath) ||
    !path.isAbsolute(evidence.canonicalRootPath) ||
    !MARKER_TOKEN_PATTERN.test(evidence.markerToken)
  ) {
    throw new IdentityStoreBoundaryError('root_not_admitted');
  }

  const normalizedRoot = path.resolve(evidence.rootPath);
  if (
    samePath(normalizedRoot, canonicalTemporaryRoot) ||
    !isPathInside(normalizedRoot, canonicalTemporaryRoot)
  ) {
    throw new IdentityStoreBoundaryError('root_not_admitted');
  }

  const root = await openDirectoryBinding(normalizedRoot, normalizedRoot, 'root_not_admitted');
  try {
    if (
      !samePath(root.canonicalPath, path.resolve(evidence.canonicalRootPath)) ||
      !isPathInside(root.canonicalPath, canonicalTemporaryRoot)
    ) {
      throw new IdentityStoreBoundaryError('root_not_admitted');
    }
    const marker = await readBoundedFile(
      root,
      TEAM_DIRECTORY_ROOT_MARKER_FILE,
      MAX_ROOT_MARKER_BYTES,
      'root_not_admitted'
    );
    if (!marker || (marker.stat.mode & 0o077) !== 0) {
      throw new IdentityStoreBoundaryError('root_not_admitted');
    }
    try {
      const value = JSON.parse(marker.raw) as Record<string, unknown>;
      if (
        value.schemaVersion !== 1 ||
        value.scope !== 'p2-d-team-directory' ||
        value.kind !== evidence.kind ||
        value.ownershipToken !== evidence.markerToken ||
        Object.keys(value).length !== 4
      ) {
        throw new IdentityStoreBoundaryError('root_not_admitted');
      }
    } catch (error) {
      if (error instanceof IdentityStoreBoundaryError) throw error;
      throw new IdentityStoreBoundaryError('root_not_admitted');
    }
    return { canonicalPath: root.canonicalPath, identity: root.identity };
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

async function openAdmittedTeamsRoot(
  admission: TeamDirectoryRootAdmission
): Promise<DirectoryBinding> {
  const canonicalTemporaryRoot = await fs.promises.realpath(os.tmpdir());
  const [projectRoot, runtimeRoot] = await Promise.all([
    assertMarkerOwnedRoot(admission.projectRoot, canonicalTemporaryRoot),
    assertMarkerOwnedRoot(admission.runtimeRoot, canonicalTemporaryRoot),
  ]);
  if (
    samePath(projectRoot.canonicalPath, runtimeRoot.canonicalPath) ||
    !path.isAbsolute(admission.teamsRootPath)
  ) {
    throw new IdentityStoreBoundaryError('root_not_admitted');
  }

  const normalizedTeamsRoot = path.resolve(admission.teamsRootPath);
  if (!isPathInside(normalizedTeamsRoot, runtimeRoot.canonicalPath)) {
    throw new IdentityStoreBoundaryError('root_not_admitted');
  }
  const teamsRoot = await openDirectoryBinding(
    normalizedTeamsRoot,
    normalizedTeamsRoot,
    'root_not_admitted'
  );
  if (!isPathInside(teamsRoot.canonicalPath, runtimeRoot.canonicalPath)) {
    await teamsRoot.handle.close().catch(() => undefined);
    throw new IdentityStoreBoundaryError('root_not_admitted');
  }
  try {
    const [freshProjectRoot, freshRuntimeRoot] = await Promise.all([
      assertMarkerOwnedRoot(admission.projectRoot, canonicalTemporaryRoot),
      assertMarkerOwnedRoot(admission.runtimeRoot, canonicalTemporaryRoot),
    ]);
    if (
      freshProjectRoot.identity.device !== projectRoot.identity.device ||
      freshProjectRoot.identity.inode !== projectRoot.identity.inode ||
      freshRuntimeRoot.identity.device !== runtimeRoot.identity.device ||
      freshRuntimeRoot.identity.inode !== runtimeRoot.identity.inode
    ) {
      throw new IdentityStoreBoundaryError('root_not_admitted');
    }
    await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
  } catch (error) {
    await teamsRoot.handle.close().catch(() => undefined);
    throw error;
  }
  return teamsRoot;
}

async function resolveTeamDirectory(
  admission: TeamDirectoryRootAdmission,
  legacyTeamKey: LegacyTeamKey,
  requireExisting: boolean
): Promise<ResolvedTeamDirectory | null> {
  parseLegacyTeamKey(legacyTeamKey);
  const teamsRoot = await openAdmittedTeamsRoot(admission);
  const logicalTeamDirectory = path.join(teamsRoot.logicalPath, legacyTeamKey);
  try {
    const targetPath = await childPathForMutation(
      teamsRoot,
      legacyTeamKey,
      'unsafe_team_directory'
    );
    const targetStat = await fs.promises.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!targetStat) {
      if (requireExisting) {
        throw new IdentityStoreBoundaryError('unsafe_team_directory');
      }
      await teamsRoot.handle.close();
      return null;
    }
    const teamDirectory = await openDirectoryBinding(
      targetPath,
      logicalTeamDirectory,
      'unsafe_team_directory'
    );
    if (!isPathInside(teamDirectory.canonicalPath, teamsRoot.canonicalPath)) {
      await teamDirectory.handle.close().catch(() => undefined);
      throw new IdentityStoreBoundaryError('unsafe_team_directory');
    }
    await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
    return { teamsRoot, teamDirectory };
  } catch (error) {
    await teamsRoot.handle.close().catch(() => undefined);
    throw error;
  }
}

async function closeResolved(resolved: ResolvedTeamDirectory): Promise<void> {
  await Promise.allSettled([
    resolved.teamDirectory.handle.close(),
    resolved.teamsRoot.handle.close(),
  ]);
}

function absentOutcome(authority: TeamIdentityAuthorityEvidence): TeamIdentityReadOutcome {
  if (authority.state === 'committed') {
    return { status: 'blocked', capability: 'blocked', reason: 'missing_after_commit' };
  }
  if (authority.state === 'file_published') {
    return { status: 'blocked', capability: 'blocked', reason: 'missing_after_publication' };
  }
  return { status: 'absent', capability: 'read_only', reason: 'awaiting_publication' };
}

async function inspectResolvedIdentity(
  resolved: ResolvedTeamDirectory,
  authority: TeamIdentityAuthorityEvidence
): Promise<TeamIdentityReadOutcome> {
  let file: Awaited<ReturnType<typeof readBoundedFile>>;
  try {
    file = await readBoundedFile(
      resolved.teamDirectory,
      TEAM_IDENTITY_FILE_NAME,
      MAX_IDENTITY_FILE_BYTES,
      'corrupt_identity'
    );
  } catch (error) {
    return {
      status: 'blocked',
      capability: 'blocked',
      reason: error instanceof IdentityStoreBoundaryError ? error.reason : 'unsafe_team_directory',
    };
  }
  if (!file) return absentOutcome(authority);
  if ((file.stat.mode & 0o077) !== 0) {
    return { status: 'blocked', capability: 'blocked', reason: 'identity_permissions_unsafe' };
  }

  const identity = parseIdentityFile(file.raw);
  if (typeof identity === 'string') {
    return { status: 'blocked', capability: 'blocked', reason: identity };
  }
  if (file.raw !== serializeTeamIdentityFile(identity)) {
    return { status: 'blocked', capability: 'blocked', reason: 'corrupt_identity' };
  }
  if (identity.teamId !== authority.teamId) {
    return { status: 'blocked', capability: 'blocked', reason: 'identity_mismatch' };
  }
  const checksum = parseTeamIdentityChecksum(createHash('sha256').update(file.raw).digest('hex'));
  if (checksum !== authority.expectedChecksum) {
    return { status: 'blocked', capability: 'blocked', reason: 'checksum_mismatch' };
  }
  return {
    status: 'valid',
    capability: authority.state === 'committed' ? 'read_write' : 'read_only',
    identity,
    checksum,
  };
}

async function syncIdentityFile(resolved: ResolvedTeamDirectory): Promise<void> {
  const identityPath = await childPathForMutation(
    resolved.teamDirectory,
    TEAM_IDENTITY_FILE_NAME,
    'unsafe_team_directory'
  );
  const handle = await fs.promises.open(identityPath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    await assertCurrentDirectoryBinding(resolved.teamDirectory, 'unsafe_team_directory');
    await handle.sync();
    await resolved.teamDirectory.handle.sync();
    await assertCurrentDirectoryBinding(resolved.teamDirectory, 'unsafe_team_directory');
  } finally {
    await handle.close();
  }
}

export class TeamIdentityFileStore implements TeamIdentityPublicationPort {
  constructor(private readonly admission: TeamDirectoryRootAdmission) {}

  async inspect(
    legacyTeamKey: LegacyTeamKey,
    authority: TeamIdentityAuthorityEvidence
  ): Promise<TeamIdentityReadOutcome> {
    if (authority.duplicateTeamIdCount > 0) {
      return { status: 'blocked', capability: 'blocked', reason: 'duplicate_team_id' };
    }
    if (authority.state === 'tombstoned') {
      return { status: 'blocked', capability: 'blocked', reason: 'identity_tombstoned' };
    }

    let resolved: ResolvedTeamDirectory | null;
    try {
      resolved = await resolveTeamDirectory(this.admission, legacyTeamKey, false);
    } catch (error) {
      return { status: 'blocked', capability: 'blocked', reason: asBoundaryReason(error) };
    }
    if (!resolved) return absentOutcome(authority);
    try {
      return await inspectResolvedIdentity(resolved, authority);
    } finally {
      await closeResolved(resolved);
    }
  }

  async publish(request: TeamIdentityPublishRequest): Promise<TeamIdentityPublishOutcome> {
    const requestedIdentity = parseIdentityFile(JSON.stringify(request.identity));
    if (typeof requestedIdentity === 'string') {
      return { status: 'blocked', capability: 'blocked', reason: requestedIdentity };
    }
    if (request.authority.duplicateTeamIdCount > 0) {
      return { status: 'blocked', capability: 'blocked', reason: 'duplicate_team_id' };
    }
    if (request.identity.teamId !== request.authority.teamId) {
      return { status: 'blocked', capability: 'blocked', reason: 'identity_mismatch' };
    }
    const checksum = checksumTeamIdentityFile(request.identity);
    if (checksum !== request.authority.expectedChecksum) {
      return { status: 'blocked', capability: 'blocked', reason: 'checksum_mismatch' };
    }

    let resolved: ResolvedTeamDirectory | null = null;
    try {
      resolved = await resolveTeamDirectory(this.admission, request.legacyTeamKey, true);
      if (!resolved) throw new IdentityStoreBoundaryError('unsafe_team_directory');
      await resolved.teamDirectory.handle.sync();
    } catch (error) {
      if (resolved) await closeResolved(resolved);
      return {
        status: 'blocked',
        capability: 'blocked',
        reason:
          error instanceof IdentityStoreBoundaryError ? error.reason : 'durability_unsupported',
      };
    }

    try {
      const existing = await inspectResolvedIdentity(resolved, request.authority);
      if (existing.status !== 'absent') {
        if (
          existing.status === 'valid' &&
          existing.identity.teamId === request.identity.teamId &&
          existing.checksum === checksum
        ) {
          try {
            await syncIdentityFile(resolved);
          } catch {
            return { status: 'blocked', capability: 'blocked', reason: 'durability_unsupported' };
          }
          return {
            status: 'already_published',
            evidence: this.buildPublicationEvidence(request, checksum),
          };
        }
        return existing.status === 'blocked'
          ? existing
          : { status: 'blocked', capability: 'blocked', reason: 'identity_mismatch' };
      }

      let handle: fs.promises.FileHandle | null = null;
      let created = false;
      try {
        const identityPath = await childPathForMutation(
          resolved.teamDirectory,
          TEAM_IDENTITY_FILE_NAME,
          'unsafe_team_directory'
        );
        handle = await fs.promises.open(
          identityPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          0o600
        );
        created = true;
        await assertCurrentDirectoryBinding(resolved.teamDirectory, 'unsafe_team_directory');
        await handle.writeFile(serializeTeamIdentityFile(request.identity), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await resolved.teamDirectory.handle.sync();
        await assertCurrentDirectoryBinding(resolved.teamDirectory, 'unsafe_team_directory');
        await assertCurrentDirectoryBinding(resolved.teamsRoot, 'root_not_admitted');
        return {
          status: 'published',
          evidence: this.buildPublicationEvidence(request, checksum),
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const raced = await inspectResolvedIdentity(resolved, request.authority);
          if (
            raced.status === 'valid' &&
            raced.identity.teamId === request.identity.teamId &&
            raced.checksum === checksum
          ) {
            try {
              await syncIdentityFile(resolved);
            } catch {
              return { status: 'blocked', capability: 'blocked', reason: 'durability_unsupported' };
            }
            return {
              status: 'already_published',
              evidence: this.buildPublicationEvidence(request, checksum),
            };
          }
          return raced.status === 'blocked'
            ? raced
            : { status: 'blocked', capability: 'blocked', reason: 'identity_mismatch' };
        }
        return {
          status: 'blocked',
          capability: 'blocked',
          reason: created ? 'publish_failed_after_create' : 'unsafe_team_directory',
        };
      }
    } finally {
      await closeResolved(resolved);
    }
  }

  private buildPublicationEvidence(
    request: TeamIdentityPublishRequest,
    checksum: TeamIdentityChecksum
  ): TeamIdentityPublicationEvidence {
    return {
      teamId: request.identity.teamId,
      legacyTeamKey: request.legacyTeamKey,
      checksum,
      fileSchemaVersion: TEAM_IDENTITY_SCHEMA_VERSION,
      publishedAt: new Date().toISOString(),
      fileFsync: 'synced',
      parentDirectoryFsync: 'synced',
    };
  }
}
