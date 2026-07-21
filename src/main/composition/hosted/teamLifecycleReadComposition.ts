import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
} from '@features/runtime-instance-context';
import {
  GetRuntimeStateProjection,
  GetTeamLifecycleSnapshot,
  ListAliveTeamProjections,
  ListTeamLifecycle,
} from '@features/team-lifecycle';
import {
  type CanonicalListTeamLifecycleResult,
  type ListAliveTeamProjectionsRequest,
  type ListTeamLifecycleRequest,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleEntityRequest,
  type TeamLifecycleReadApi,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import {
  type LegacyTeamBindingPage,
  type LegacyTeamDataReadPort,
  type LegacyTeamIdentityBinding,
  type LegacyTeamIdentityReadPort,
  LegacyTeamLifecycleReadSource,
  type LegacyTeamReadAvailability,
  type LegacyTeamRuntimeReadPort,
  TeamLifecycleReadApiAdapter,
} from '@features/team-lifecycle/main';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import {
  type ActorId,
  type AuthorizedScope,
  type BootId,
  createQueryContext,
  createSafeAppError,
  type DeploymentId,
  parseActorId,
  parseAuthorizedScope,
  parseCursor,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  type QueryContext,
  type Revision,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  type AuthoritativeTeamRuntimeEvidenceSource,
  createMountBindingScopedRuntimeEvidencePort,
  TeamRuntimeEvidenceUnavailableError,
} from './teamRuntimeEvidenceSource';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const MAX_LEGACY_SUMMARIES = 2_000;
const MAX_HOSTED_TEAM_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_HOSTED_TEAM_IDENTITY_BYTES = 4 * 1024;
const TEAM_LIFECYCLE_READ_CURSOR_PREFIX = 'cursor_team_lifecycle_read';
const TEAM_LIFECYCLE_READ_CURSOR_PATTERN = /^cursor_team_lifecycle_read_(\d+)_([0-9a-f]{64})$/;
const COMPATIBILITY_CURSOR_READ_PATTERN = /^cursor_phase2_(\d+)_([0-9a-f]{64})$/;
const TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS = Object.freeze({
  identityCorrupt: 'team-lifecycle-read.identity-corrupt',
  dataCorrupt: 'team-lifecycle-read.data-corrupt',
  clockInvalid: 'team-lifecycle-read.clock-invalid',
  projectionPurposeInvalid: 'team-lifecycle-read.projection-purpose-invalid',
  hostUnexpected: 'team-lifecycle-read.host-unexpected',
  requestErrorInvalid: 'team-lifecycle-read.request-error-invalid',
});
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const teamLifecycleReadAuthorities = new WeakSet<object>();

export interface TeamLifecycleReadAuthority {
  readonly actorId: ActorId;
  readonly authorizedScope: AuthorizedScope;
  readonly workspaceId: WorkspaceId;
  readonly workspaceGeneration: number;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
}

export interface TeamLifecycleReadAuthorityInput {
  readonly actorId: unknown;
  readonly authorizedScope: unknown;
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
}

export interface TeamLifecycleReadCompositionDependencies {
  /** The host-created identity and authorization snapshot for every read in this composition. */
  readonly authority: TeamLifecycleReadAuthority;
  /** Null means the durable component is unavailable; discovery fallback is forbidden. */
  readonly teamIdentities: TeamIdentityReadGateway | null;
  readonly legacyData: LegacyTeamDataReadPort;
  readonly legacyRuntime: LegacyTeamRuntimeReadPort;
  readonly nowMs: () => number;
  readonly pageSize?: number;
}

export interface TeamLifecycleReadComposition {
  readonly authority: TeamLifecycleReadAuthority;
  readonly teamLifecycle: TeamLifecycleReadApi;
}

export interface MountBindingScopedTeamLifecycleReadPorts {
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly legacyData: LegacyTeamDataReadPort;
  readonly legacyRuntime: LegacyTeamRuntimeReadPort;
}

export interface HostedReadOnlyTeamSummarySource {
  readTeamSummary(input: {
    readonly claudeRoot: string;
    readonly identity: TeamIdentityRecord;
    readonly context: QueryContext;
    readonly assertActive: () => void;
  }): Promise<Readonly<Record<PropertyKey, unknown>> | null>;
}

export interface MountBindingScopedTeamLifecycleReadPortsInput {
  readonly authority: TeamLifecycleReadAuthority;
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs: () => number;
  /** Test seam for the narrow read-only adapter; production uses explicit-root filesystem reads. */
  readonly teamSummarySource?: HostedReadOnlyTeamSummarySource;
  /** Omit unless the host owns authoritative evidence already scoped to this exact mount. */
  readonly runtimeEvidenceSource?: AuthoritativeTeamRuntimeEvidenceSource;
}

export interface TeamLifecycleReadHost {
  listTeamLifecycle(
    request: unknown,
    requestSignal?: AbortSignal
  ): Promise<CanonicalListTeamLifecycleResult>;
}

interface FrozenLegacyLifecycleSummary extends Readonly<Record<PropertyKey, unknown>> {
  readonly teamName: string;
}

interface TeamLifecycleReadSnapshot {
  readonly identities: readonly TeamIdentityRecord[];
  readonly summaries: readonly FrozenLegacyLifecycleSummary[];
  readonly summariesByName: ReadonlyMap<string, FrozenLegacyLifecycleSummary>;
  readonly revision: Revision;
}

interface FrozenRuntimeState {
  readonly teamName: string;
  readonly isAlive: boolean;
}

interface DirectoryEntryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

type IdentityProjectionPurpose = 'lifecycle' | 'runtime';

/** Reads stable cursors and the compatibility wire form; cursor writes stay stable-only. */
function matchTeamLifecycleReadCursorForRead(value: string): RegExpExecArray | null {
  return (
    TEAM_LIFECYCLE_READ_CURSOR_PATTERN.exec(value) ?? COMPATIBILITY_CURSOR_READ_PATTERN.exec(value)
  );
}

function failure(
  code: TeamLifecycleReadFailure['error']['code'],
  reason: string,
  diagnosticId?: string
): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code, reason, diagnosticId });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: code === 'unavailable',
  });
}

function corruptIdentity(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.identityCorrupt);
}

function corruptData(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.dataCorrupt);
}

function identityUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'identity_storage_unavailable');
}

function dataUnavailable(): TeamLifecycleReadFailure {
  return failure('unavailable', 'source_unavailable');
}

function forbiddenContext(): TeamLifecycleReadFailure {
  return failure('forbidden', 'scope_not_authorized');
}

function cancelledContext(
  reason: 'request_cancelled' | 'deadline_exceeded'
): TeamLifecycleReadFailure {
  return failure('cancelled', reason);
}

function clockInvalid(): TeamLifecycleReadFailure {
  return failure('internal', 'policy_failure', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.clockInvalid);
}

function snapshotChanged(): TeamLifecycleReadFailure {
  return failure('conflict', 'snapshot_changed');
}

function invalidCursor(): TeamLifecycleReadFailure {
  return failure('invalid_request', 'cursor_invalid');
}

function projectionPurposeInvalid(): TeamLifecycleReadFailure {
  return failure(
    'internal',
    'unexpected',
    TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.projectionPurposeInvalid
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectedRevision(identity: TeamIdentityRecord, projection: unknown): Revision {
  return parseRevision(`revision_${digest({ identity, projection })}`);
}

function availability(
  identity: TeamIdentityRecord,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamReadAvailability {
  switch (identity.state) {
    case 'reserved':
      return 'draft';
    case 'adoption_prepared':
    case 'file_published':
      return 'provisioning';
    case 'active':
      return summary?.pendingCreate === true ? 'draft' : 'current';
    case 'tombstoned':
      return 'current';
  }
}

function binding(
  identity: TeamIdentityRecord,
  projection: unknown,
  summary: FrozenLegacyLifecycleSummary | null
): LegacyTeamIdentityBinding | TeamLifecycleReadFailure {
  if (identity.workspaceBinding === null) return corruptIdentity();
  return Object.freeze({
    workspaceId: identity.workspaceBinding.workspaceId,
    teamId: identity.teamId,
    legacyTeamName: identity.legacyKey,
    displayName: identity.legacyKey,
    revision: projectedRevision(identity, projection),
    availability: availability(identity, summary),
  });
}

function isFailure(
  value: LegacyTeamIdentityBinding | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value && value.kind === 'failure';
}

function isSnapshotFailure(
  value: TeamLifecycleReadSnapshot | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

function isRuntimeFailure(
  value: FrozenRuntimeState | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return 'kind' in value;
}

function isAliveNamesFailure(
  value: readonly string[] | TeamLifecycleReadFailure
): value is TeamLifecycleReadFailure {
  return !Array.isArray(value);
}

function authorityCursorDigest(
  authority: TeamLifecycleReadAuthority,
  revision: Revision,
  offset: number
): string {
  return digest({
    snapshotRevision: revision,
    actorId: authority.actorId,
    authorizedScope: authority.authorizedScope,
    workspaceId: authority.workspaceId,
    workspaceGeneration: authority.workspaceGeneration,
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    offset,
  });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertCanonicalIdentityFile(
  serialized: string,
  expectedIdentity: TeamIdentityRecord
): void {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('team-lifecycle-read-canonical-identity-invalid');
  }
  if (!isRecord(value)) throw new Error('team-lifecycle-read-canonical-identity-invalid');

  const expectedKeys =
    value.originDeploymentId === undefined
      ? ['createdAt', 'schemaVersion', 'teamId']
      : ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId'];
  const keys = Reflect.ownKeys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error('team-lifecycle-read-canonical-identity-invalid');
  }

  const canonicalIdentity: Record<string, unknown> = {
    schemaVersion: 1,
    teamId: parseTeamId(value.teamId),
    createdAt: value.createdAt,
  };
  if (value.originDeploymentId !== undefined) {
    canonicalIdentity.originDeploymentId = parseDeploymentId(value.originDeploymentId);
  }
  const canonicalSerialized = `${JSON.stringify(canonicalIdentity, null, 2)}\n`;
  if (
    serialized !== canonicalSerialized ||
    canonicalIdentity.teamId !== expectedIdentity.teamId ||
    canonicalIdentity.createdAt !== expectedIdentity.createdAt ||
    expectedIdentity.identityChecksum === null ||
    createHash('sha256').update(serialized, 'utf8').digest('hex') !==
      expectedIdentity.identityChecksum
  ) {
    throw new Error('team-lifecycle-read-canonical-identity-mismatch');
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

function entryIdentity(stat: fs.Stats): EntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameEntry(stat: fs.Stats, expected: EntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function directoryEntryIdentity(stat: fs.BigIntStats): DirectoryEntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameDirectoryEntry(stat: fs.BigIntStats, expected: DirectoryEntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function canonicalDirectoryInstanceFingerprint(
  canonicalPath: string,
  stat: fs.BigIntStats
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        canonicalPath,
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
      }),
      'utf8'
    )
    .digest('hex');
}

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw new Error('team-lifecycle-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function stableFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    sameEntry(after, entryIdentity(before)) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function assertDirectChild(root: string, candidate: string, expectedRelativePath: string): void {
  const actualRelativePath = relative(root, candidate);
  if (
    actualRelativePath !== expectedRelativePath ||
    actualRelativePath.startsWith('..') ||
    isAbsolute(actualRelativePath)
  ) {
    throw new Error('team-lifecycle-read-root-containment-invalid');
  }
}

async function activeFileIo<TResult>(
  assertActive: () => void,
  operation: () => Promise<TResult>
): Promise<TResult> {
  assertActive();
  try {
    const value = await operation();
    assertActive();
    return value;
  } catch (error) {
    assertActive();
    throw error;
  }
}

async function closeActiveFileHandle(
  handle: fs.promises.FileHandle,
  assertActive: () => void
): Promise<void> {
  let firstError: unknown;
  try {
    assertActive();
  } catch (error) {
    firstError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    assertActive();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError === undefined) return;
  if (firstError instanceof Error) throw firstError;
  throw new Error('team-lifecycle-read-file-handle-close-failed', { cause: firstError });
}

async function openActiveFileHandle(
  filePath: string,
  assertActive: () => void
): Promise<fs.promises.FileHandle> {
  assertActive();
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, noFollowReadFlags());
    assertActive();
    return handle;
  } catch (error) {
    if (handle) await closeActiveFileHandle(handle, assertActive);
    else assertActive();
    throw error;
  }
}

async function readActiveAtMost(
  handle: fs.promises.FileHandle,
  maxBytes: number,
  assertActive: () => void
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await activeFileIo(assertActive, () =>
      handle.read(buffer, offset, buffer.length - offset, offset)
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readCanonicalDirectory(
  directoryPath: string,
  expectedParent: string | null,
  expectedName: string | null,
  assertActive: () => void
): Promise<{ readonly canonicalPath: string; readonly stat: fs.BigIntStats }> {
  const stat = await activeFileIo(assertActive, () =>
    fs.promises.lstat(directoryPath, { bigint: true })
  );
  const canonicalPath = await activeFileIo(assertActive, () => fs.promises.realpath(directoryPath));
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath !== directoryPath) {
    throw new Error('team-lifecycle-read-directory-binding-invalid');
  }
  if (expectedParent !== null && expectedName !== null) {
    assertDirectChild(expectedParent, canonicalPath, expectedName);
  }
  return Object.freeze({ canonicalPath, stat });
}

class ExplicitRootReadOnlyTeamSummarySource implements HostedReadOnlyTeamSummarySource {
  async readTeamSummary(input: {
    readonly claudeRoot: string;
    readonly identity: TeamIdentityRecord;
    readonly context: QueryContext;
    readonly assertActive: () => void;
  }): Promise<Readonly<Record<PropertyKey, unknown>> | null> {
    const identity = parseTeamIdentityRecord(input.identity);
    if (identity.state !== 'active') {
      throw new Error('team-lifecycle-read-canonical-identity-state-invalid');
    }
    const legacyTeamName = parseLegacyTeamKey(identity.legacyKey);

    try {
      const claudeRoot = await readCanonicalDirectory(
        input.claudeRoot,
        null,
        null,
        input.assertActive
      );
      const teamsRoot = await readCanonicalDirectory(
        join(claudeRoot.canonicalPath, 'teams'),
        claudeRoot.canonicalPath,
        'teams',
        input.assertActive
      );
      const teamRoot = await readCanonicalDirectory(
        join(teamsRoot.canonicalPath, legacyTeamName),
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      const identityName = 'team.identity.json';
      const identityPath = join(teamRoot.canonicalPath, identityName);
      const identityStat = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(identityPath)
      );
      const canonicalIdentityPath = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(identityPath)
      );
      assertDirectChild(teamRoot.canonicalPath, canonicalIdentityPath, identityName);
      if (
        !identityStat.isFile() ||
        identityStat.isSymbolicLink() ||
        canonicalIdentityPath !== identityPath ||
        identityStat.size < 1 ||
        identityStat.size > MAX_HOSTED_TEAM_IDENTITY_BYTES
      ) {
        throw new Error('team-lifecycle-read-canonical-identity-invalid');
      }

      const identityHandle = await openActiveFileHandle(identityPath, input.assertActive);
      let serializedIdentityBuffer: Buffer;
      try {
        const openedIdentityStat = await activeFileIo(input.assertActive, () =>
          identityHandle.stat()
        );
        if (!openedIdentityStat.isFile() || !stableFile(identityStat, openedIdentityStat)) {
          throw new Error('team-lifecycle-read-canonical-identity-replaced');
        }
        serializedIdentityBuffer = await readActiveAtMost(
          identityHandle,
          MAX_HOSTED_TEAM_IDENTITY_BYTES,
          input.assertActive
        );
        const afterIdentityReadStat = await activeFileIo(input.assertActive, () =>
          identityHandle.stat()
        );
        if (
          serializedIdentityBuffer.length > MAX_HOSTED_TEAM_IDENTITY_BYTES ||
          !stableFile(openedIdentityStat, afterIdentityReadStat) ||
          afterIdentityReadStat.size !== serializedIdentityBuffer.length
        ) {
          throw new Error('team-lifecycle-read-canonical-identity-changed');
        }
      } finally {
        await closeActiveFileHandle(identityHandle, input.assertActive);
      }
      assertCanonicalIdentityFile(serializedIdentityBuffer.toString('utf8'), identity);

      const fingerprintedTeamRoot = await readCanonicalDirectory(
        teamRoot.canonicalPath,
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      if (
        !sameDirectoryEntry(fingerprintedTeamRoot.stat, directoryEntryIdentity(teamRoot.stat)) ||
        canonicalDirectoryInstanceFingerprint(
          fingerprintedTeamRoot.canonicalPath,
          fingerprintedTeamRoot.stat
        ) !== identity.directoryFingerprint
      ) {
        throw new Error('team-lifecycle-read-directory-fingerprint-mismatch');
      }

      const configName = 'config.json';
      const configPath = join(teamRoot.canonicalPath, configName);
      const configStat = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(configPath)
      );
      const canonicalConfigPath = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(configPath)
      );
      assertDirectChild(teamRoot.canonicalPath, canonicalConfigPath, configName);
      if (
        !configStat.isFile() ||
        configStat.isSymbolicLink() ||
        canonicalConfigPath !== configPath ||
        configStat.size < 0 ||
        configStat.size > MAX_HOSTED_TEAM_CONFIG_BYTES
      ) {
        input.assertActive();
        return null;
      }

      const handle = await openActiveFileHandle(configPath, input.assertActive);
      let serializedBuffer: Buffer;
      try {
        const openedStat = await activeFileIo(input.assertActive, () => handle.stat());
        if (!openedStat.isFile() || !stableFile(configStat, openedStat)) {
          throw new Error('team-lifecycle-read-config-replaced');
        }
        serializedBuffer = await readActiveAtMost(
          handle,
          MAX_HOSTED_TEAM_CONFIG_BYTES,
          input.assertActive
        );
        const afterReadStat = await activeFileIo(input.assertActive, () => handle.stat());
        if (
          serializedBuffer.length > MAX_HOSTED_TEAM_CONFIG_BYTES ||
          !stableFile(openedStat, afterReadStat) ||
          afterReadStat.size !== serializedBuffer.length
        ) {
          throw new Error('team-lifecycle-read-config-changed');
        }
      } finally {
        await closeActiveFileHandle(handle, input.assertActive);
      }

      const claudeRootAfter = await readCanonicalDirectory(
        input.claudeRoot,
        null,
        null,
        input.assertActive
      );
      const teamsRootAfter = await readCanonicalDirectory(
        teamsRoot.canonicalPath,
        claudeRoot.canonicalPath,
        'teams',
        input.assertActive
      );
      const teamRootAfter = await readCanonicalDirectory(
        teamRoot.canonicalPath,
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      const identityAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(identityPath)
      );
      const identityPathAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(identityPath)
      );
      assertDirectChild(teamRoot.canonicalPath, identityPathAfter, identityName);
      const configAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(configPath)
      );
      const configPathAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(configPath)
      );
      assertDirectChild(teamRoot.canonicalPath, configPathAfter, configName);
      if (
        !sameDirectoryEntry(claudeRootAfter.stat, directoryEntryIdentity(claudeRoot.stat)) ||
        !sameDirectoryEntry(teamsRootAfter.stat, directoryEntryIdentity(teamsRoot.stat)) ||
        !sameDirectoryEntry(
          teamRootAfter.stat,
          directoryEntryIdentity(fingerprintedTeamRoot.stat)
        ) ||
        !stableFile(identityStat, identityAfter) ||
        identityPathAfter !== canonicalIdentityPath ||
        !stableFile(configStat, configAfter) ||
        configPathAfter !== canonicalConfigPath
      ) {
        throw new Error('team-lifecycle-read-config-binding-changed');
      }

      input.assertActive();
      const serialized = serializedBuffer.toString('utf8');
      const config = JSON.parse(serialized) as unknown;
      if (!isRecord(config) || config.name !== legacyTeamName) {
        input.assertActive();
        return null;
      }

      const summary: Record<string, unknown> = { teamName: legacyTeamName };
      if (typeof config.deletedAt === 'string') summary.deletedAt = config.deletedAt;
      if (config.pendingCreate === true) summary.pendingCreate = true;
      if (config.partialLaunchFailure === true) summary.partialLaunchFailure = true;
      input.assertActive();
      return Object.freeze(summary);
    } catch (error) {
      input.assertActive();
      if (isMissingPathError(error)) {
        input.assertActive();
        return null;
      }
      throw error;
    }
  }
}

class MountBindingScopedIdentityGateway implements TeamIdentityReadGateway {
  private currentIdentities: readonly TeamIdentityRecord[] = Object.freeze([]);

  constructor(
    private readonly source: TeamIdentityReadGateway,
    private readonly mountBinding: WorkspaceMountBinding
  ) {}

  async listTeamIdentities(): Promise<readonly TeamIdentityRecord[]> {
    const values = await this.source.listTeamIdentities();
    if (!Array.isArray(values)) {
      throw new TypeError('team-lifecycle-read-identity-source-invalid');
    }
    const identities = values.flatMap((value) => {
      const identity = parseTeamIdentityRecord(value);
      const workspaceBinding = identity.workspaceBinding;
      if (workspaceBinding === null) {
        throw new TypeError('team-lifecycle-read-identity-binding-invalid');
      }
      if (workspaceBinding.workspaceId !== this.mountBinding.workspaceId) return [];
      if (workspaceBinding.generation !== this.mountBinding.mountGeneration) {
        throw new TypeError('team-lifecycle-read-identity-binding-generation-invalid');
      }
      return [identity];
    });
    this.currentIdentities = Object.freeze(identities);
    return this.currentIdentities;
  }

  async getTeamIdentity(teamId: Parameters<TeamIdentityReadGateway['getTeamIdentity']>[0]) {
    const value = await this.source.getTeamIdentity(teamId);
    if (value === null) return null;
    const identity = parseTeamIdentityRecord(value);
    const workspaceBinding = identity.workspaceBinding;
    if (workspaceBinding === null) {
      throw new TypeError('team-lifecycle-read-identity-binding-invalid');
    }
    if (workspaceBinding.workspaceId !== this.mountBinding.workspaceId) return null;
    if (workspaceBinding.generation !== this.mountBinding.mountGeneration) {
      throw new TypeError('team-lifecycle-read-identity-binding-generation-invalid');
    }
    return identity;
  }

  identitiesForCurrentSnapshot(): readonly TeamIdentityRecord[] {
    return this.currentIdentities;
  }
}

class MountBindingScopedLegacyDataPort implements LegacyTeamDataReadPort {
  constructor(
    private readonly claudeRoot: string,
    private readonly identities: MountBindingScopedIdentityGateway,
    private readonly source: HostedReadOnlyTeamSummarySource,
    private readonly nowMs: () => number
  ) {}

  private assertActive(context: QueryContext): void {
    if (context.signal.aborted) throw new Error('team-lifecycle-read-request-cancelled');
    const nowMs = this.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= context.deadlineAtMs) {
      throw new Error('team-lifecycle-read-request-expired');
    }
  }

  private async readSummary(
    identity: TeamIdentityRecord,
    context: QueryContext
  ): Promise<Readonly<Record<PropertyKey, unknown>> | null> {
    this.assertActive(context);
    try {
      const summary = await this.source.readTeamSummary({
        claudeRoot: this.claudeRoot,
        identity,
        context,
        assertActive: () => this.assertActive(context),
      });
      this.assertActive(context);
      return summary;
    } catch (error) {
      this.assertActive(context);
      throw error;
    }
  }

  async listTeams(context: QueryContext): Promise<unknown> {
    const summaries: Readonly<Record<PropertyKey, unknown>>[] = [];
    for (const identity of this.identities.identitiesForCurrentSnapshot()) {
      if (identity.state !== 'active') continue;
      const summary = await this.readSummary(identity, context);
      if (summary) summaries.push(summary);
    }
    return Object.freeze(summaries);
  }

  async getTeamData(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const identity = this.identities
      .identitiesForCurrentSnapshot()
      .find((candidate) => candidate.legacyKey === legacyTeamName);
    if (!identity) throw new Error('team-lifecycle-read-team-outside-mount-binding');
    const summary = await this.readSummary(identity, context);
    if (!summary) throw new Error('team-lifecycle-read-team-data-unavailable');
    const config =
      typeof summary.deletedAt === 'string'
        ? Object.freeze({ deletedAt: summary.deletedAt })
        : Object.freeze({});
    const warnings =
      summary.partialLaunchFailure === true ? Object.freeze(['degraded']) : Object.freeze([]);
    return Object.freeze({ teamName: legacyTeamName, config, warnings });
  }
}

function projectSummary(
  legacyTeamName: string,
  value: Record<PropertyKey, unknown>
): FrozenLegacyLifecycleSummary {
  const summary: Record<string, unknown> = { teamName: legacyTeamName };
  if (typeof value.deletedAt === 'string') summary.deletedAt = value.deletedAt;
  if (value.pendingCreate === true) summary.pendingCreate = true;
  if (value.partialLaunchFailure === true) summary.partialLaunchFailure = true;
  return Object.freeze(summary) as FrozenLegacyLifecycleSummary;
}

function tombstoneSummary(identity: TeamIdentityRecord): FrozenLegacyLifecycleSummary {
  return Object.freeze({
    teamName: identity.legacyKey,
    deletedAt: identity.tombstonedAt,
  });
}

export function createTeamLifecycleReadAuthority(
  value: TeamLifecycleReadAuthorityInput
): TeamLifecycleReadAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  try {
    if (!(value.mountBinding instanceof WorkspaceMountBinding)) {
      throw new TypeError('team-lifecycle-read-mount-binding-not-admitted');
    }
    if (value.mountBinding.health === 'unavailable') {
      throw new TypeError('team-lifecycle-read-mount-binding-unavailable');
    }
    const runtimeInstance = createRuntimeInstanceContext(value.runtimeInstance);
    if (value.mountBinding.bootId !== runtimeInstance.bootId) {
      throw new TypeError('team-lifecycle-read-runtime-binding-mismatch');
    }
    const authority = Object.freeze({
      actorId: parseActorId(value.actorId),
      authorizedScope: parseAuthorizedScope(value.authorizedScope),
      workspaceId: value.mountBinding.workspaceId,
      workspaceGeneration: value.mountBinding.mountGeneration,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
    });
    teamLifecycleReadAuthorities.add(authority);
    return authority;
  } catch {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
}

/**
 * Builds the hosted-only read ports from one admitted mount binding and explicit runtime roots.
 * The adapters never enumerate the ambient teams root and expose no write, process, provider, or
 * cleanup capability. Legacy config reads are limited to keys returned for this mount binding.
 */
export function createMountBindingScopedTeamLifecycleReadPorts(
  input: MountBindingScopedTeamLifecycleReadPortsInput
): MountBindingScopedTeamLifecycleReadPorts {
  if (!teamLifecycleReadAuthorities.has(input.authority)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  if (!(input.mountBinding instanceof WorkspaceMountBinding)) {
    throw new TypeError('team-lifecycle-read-mount-binding-invalid');
  }
  const runtimeInstance = createRuntimeInstanceContext(input.runtimeInstance);
  if (
    input.mountBinding.health === 'unavailable' ||
    input.mountBinding.bootId !== runtimeInstance.bootId ||
    input.authority.workspaceId !== input.mountBinding.workspaceId ||
    input.authority.workspaceGeneration !== input.mountBinding.mountGeneration ||
    input.authority.deploymentId !== runtimeInstance.deploymentId ||
    input.authority.bootId !== runtimeInstance.bootId
  ) {
    throw new TypeError('team-lifecycle-read-mount-binding-invalid');
  }
  if (typeof input.nowMs !== 'function') {
    throw new TypeError('team-lifecycle-read-clock-invalid');
  }

  const claudeRoot = runtimeInstance.claudeRoot.reference as string;
  if (
    !isAbsolute(claudeRoot) ||
    resolve(claudeRoot) !== claudeRoot ||
    claudeRoot === resolve(claudeRoot, '/')
  ) {
    throw new TypeError('team-lifecycle-read-claude-root-invalid');
  }

  const identities = new MountBindingScopedIdentityGateway(
    input.teamIdentities,
    input.mountBinding
  );
  return Object.freeze({
    teamIdentities: identities,
    legacyData: new MountBindingScopedLegacyDataPort(
      claudeRoot,
      identities,
      input.teamSummarySource ?? new ExplicitRootReadOnlyTeamSummarySource(),
      input.nowMs
    ),
    legacyRuntime: createMountBindingScopedRuntimeEvidencePort({
      mountBinding: input.mountBinding,
      runtimeInstance,
      identitiesForCurrentSnapshot: () => identities.identitiesForCurrentSnapshot(),
      nowMs: input.nowMs,
      source: input.runtimeEvidenceSource,
    }),
  });
}

/** Owns the one immutable identity/data snapshot used throughout a host request. */
export class TeamLifecycleReadSnapshotCoordinator {
  private readonly snapshots = new WeakMap<
    QueryContext,
    Promise<TeamLifecycleReadSnapshot | TeamLifecycleReadFailure>
  >();
  private readonly runtimeStates = new WeakMap<
    QueryContext,
    Map<string, Promise<FrozenRuntimeState | TeamLifecycleReadFailure>>
  >();
  private readonly aliveNames = new WeakMap<
    QueryContext,
    Promise<readonly string[] | TeamLifecycleReadFailure>
  >();

  constructor(
    readonly authority: TeamLifecycleReadAuthority,
    private readonly identityGateway: TeamIdentityReadGateway | null,
    private readonly legacyData: LegacyTeamDataReadPort,
    private readonly legacyRuntime: LegacyTeamRuntimeReadPort,
    private readonly nowMs: () => number
  ) {}

  admitContext(context: QueryContext): boolean {
    return (
      context.actorId === this.authority.actorId &&
      context.authorizedScope === this.authority.authorizedScope &&
      context.deploymentId === this.authority.deploymentId &&
      context.bootId === this.authority.bootId
    );
  }

  private preflight(context: QueryContext): TeamLifecycleReadFailure | null {
    if (!this.admitContext(context)) return forbiddenContext();
    if (context.signal.aborted) return cancelledContext('request_cancelled');
    try {
      const nowMs = this.nowMs();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return clockInvalid();
      return nowMs >= context.deadlineAtMs ? cancelledContext('deadline_exceeded') : null;
    } catch {
      return clockInvalid();
    }
  }

  async readSnapshot(
    context: QueryContext
  ): Promise<TeamLifecycleReadSnapshot | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const existing = this.snapshots.get(context);
    if (existing) {
      const snapshot = await existing;
      return this.preflight(context) ?? snapshot;
    }

    const pending = this.loadSnapshot(context);
    this.snapshots.set(context, pending);
    const snapshot = await pending;
    return this.preflight(context) ?? snapshot;
  }

  private async loadSnapshot(
    context: QueryContext
  ): Promise<TeamLifecycleReadSnapshot | TeamLifecycleReadFailure> {
    if (!this.identityGateway) return identityUnavailable();

    let identityValues: readonly TeamIdentityRecord[];
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      identityValues = await this.identityGateway.listTeamIdentities();
    } catch {
      return this.preflight(context) ?? identityUnavailable();
    }
    const afterIdentityRead = this.preflight(context);
    if (afterIdentityRead) return afterIdentityRead;

    let identities: readonly TeamIdentityRecord[];
    try {
      if (!Array.isArray(identityValues)) return corruptIdentity();
      const parsed = identityValues.map((identity) => parseTeamIdentityRecord(identity));
      if (
        new Set(parsed.map((identity) => identity.teamId)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.legacyKey)).size !== parsed.length ||
        new Set(parsed.map((identity) => identity.directoryFingerprint)).size !== parsed.length
      ) {
        return corruptIdentity();
      }
      const localIdentities: TeamIdentityRecord[] = [];
      for (const identity of parsed) {
        const workspaceBinding = identity.workspaceBinding;
        if (workspaceBinding === null) return corruptIdentity();
        if (workspaceBinding.workspaceId !== this.authority.workspaceId) continue;
        if (workspaceBinding.generation !== this.authority.workspaceGeneration) {
          return snapshotChanged();
        }
        localIdentities.push(identity);
      }
      identities = Object.freeze(
        localIdentities.sort((left, right) => left.teamId.localeCompare(right.teamId))
      );
    } catch {
      return corruptIdentity();
    }

    let summaryValues: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      summaryValues = await this.legacyData.listTeams(context);
    } catch {
      return this.preflight(context) ?? dataUnavailable();
    }
    const afterLegacyDataRead = this.preflight(context);
    if (afterLegacyDataRead) return afterLegacyDataRead;

    let summaries: readonly FrozenLegacyLifecycleSummary[];
    try {
      if (!Array.isArray(summaryValues) || summaryValues.length > MAX_LEGACY_SUMMARIES) {
        return corruptData();
      }
      const localNames = new Set(identities.map((identity) => identity.legacyKey as string));
      const byLegacyName = new Map<string, FrozenLegacyLifecycleSummary>();
      for (let index = 0; index < summaryValues.length; index += 1) {
        if (!Object.hasOwn(summaryValues, index)) return corruptData();
        const candidate = summaryValues[index];
        if (!isRecord(candidate) || typeof candidate.teamName !== 'string') return corruptData();
        if (!localNames.has(candidate.teamName)) continue;
        if (byLegacyName.has(candidate.teamName)) return corruptData();
        byLegacyName.set(candidate.teamName, projectSummary(candidate.teamName, candidate));
      }

      summaries = Object.freeze(
        identities.flatMap((identity) => {
          if (identity.state === 'tombstoned') return [tombstoneSummary(identity)];
          const summary = byLegacyName.get(identity.legacyKey);
          return summary ? [summary] : [];
        })
      );
    } catch {
      return corruptData();
    }

    const summariesByName = new Map(summaries.map((summary) => [summary.teamName, summary]));
    const revision = parseRevision(
      `revision_${digest(
        identities.map((identity) => ({
          identity,
          summary: summariesByName.get(identity.legacyKey) ?? null,
        }))
      )}`
    );
    return Object.freeze({ identities, summaries, summariesByName, revision });
  }

  async readRuntimeState(
    legacyTeamName: string,
    context: QueryContext
  ): Promise<FrozenRuntimeState | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const snapshot = await this.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    if (!snapshot.identities.some((identity) => identity.legacyKey === legacyTeamName)) {
      return forbiddenContext();
    }

    let byTeamName = this.runtimeStates.get(context);
    if (!byTeamName) {
      byTeamName = new Map();
      this.runtimeStates.set(context, byTeamName);
    }
    const existing = byTeamName.get(legacyTeamName);
    if (existing) {
      const runtime = await existing;
      return this.preflight(context) ?? runtime;
    }

    const pending = this.loadRuntimeState(legacyTeamName, context);
    byTeamName.set(legacyTeamName, pending);
    const runtime = await pending;
    return this.preflight(context) ?? runtime;
  }

  async readAliveNames(
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    const preflight = this.preflight(context);
    if (preflight) return preflight;
    const snapshot = await this.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const existing = this.aliveNames.get(context);
    if (existing) {
      const names = await existing;
      return this.preflight(context) ?? names;
    }

    const pending = this.loadAliveNames(snapshot, context);
    this.aliveNames.set(context, pending);
    const names = await pending;
    return this.preflight(context) ?? names;
  }

  private async loadRuntimeState(
    legacyTeamName: string,
    context: QueryContext
  ): Promise<FrozenRuntimeState | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      value = await this.legacyRuntime.getRuntimeState(legacyTeamName, context);
    } catch {
      return this.preflight(context) ?? dataUnavailable();
    }
    const afterRuntimeRead = this.preflight(context);
    if (afterRuntimeRead) return afterRuntimeRead;
    if (
      !isRecord(value) ||
      value.teamName !== legacyTeamName ||
      typeof value.isAlive !== 'boolean'
    ) {
      return corruptData();
    }
    return Object.freeze({ teamName: legacyTeamName, isAlive: value.isAlive });
  }

  private async loadAliveNames(
    snapshot: TeamLifecycleReadSnapshot,
    context: QueryContext
  ): Promise<readonly string[] | TeamLifecycleReadFailure> {
    let value: unknown;
    try {
      const preflight = this.preflight(context);
      if (preflight) return preflight;
      value = await this.legacyRuntime.getAliveTeams(context);
    } catch {
      return this.preflight(context) ?? dataUnavailable();
    }
    const afterRuntimeRead = this.preflight(context);
    if (afterRuntimeRead) return afterRuntimeRead;
    if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE) return corruptData();
    const localNames = new Set(snapshot.identities.map((identity) => identity.legacyKey as string));
    const seen = new Set<string>();
    const names: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || typeof value[index] !== 'string') return corruptData();
      const name = value[index];
      if (seen.has(name)) return corruptData();
      seen.add(name);
      if (localNames.has(name)) names.push(name);
    }
    names.sort();
    return Object.freeze(names);
  }
}

class IdentityProjectionPurposeContext {
  private readonly purposes = new WeakMap<QueryContext, IdentityProjectionPurpose>();

  async run<TResult>(
    context: QueryContext,
    purpose: IdentityProjectionPurpose,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    if (this.purposes.has(context)) {
      throw new Error('team-lifecycle-read-projection-purpose-context-reused');
    }
    this.purposes.set(context, purpose);
    try {
      return await operation();
    } finally {
      this.purposes.delete(context);
    }
  }

  current(context: QueryContext): IdentityProjectionPurpose | null {
    return this.purposes.get(context) ?? null;
  }
}

class CanonicalIdentityProjectionReadPort implements LegacyTeamIdentityReadPort {
  constructor(
    private readonly coordinator: TeamLifecycleReadSnapshotCoordinator,
    private readonly pageSize: number,
    private readonly purposes: IdentityProjectionPurposeContext
  ) {}

  async listTeamBindings(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'lifecycle') return projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    return this.page(
      snapshot.identities,
      snapshot.revision,
      request.cursor,
      snapshot,
      (identity) => snapshot.summariesByName.get(identity.legacyKey) ?? null
    );
  }

  async getTeamBinding(
    request: TeamLifecycleEntityRequest,
    context: QueryContext
  ): Promise<LegacyTeamIdentityBinding | TeamLifecycleReadFailure | null> {
    const purpose = this.purposes.current(context);
    if (purpose === null) return projectionPurposeInvalid();
    if (request.workspaceId !== this.coordinator.authority.workspaceId) return forbiddenContext();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const identity = snapshot.identities.find((candidate) => candidate.teamId === request.teamId);
    if (!identity) return null;
    const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
    let projection: unknown = summary;
    if (purpose === 'runtime') {
      if (availability(identity, summary) === 'draft') return dataUnavailable();
      const runtime = await this.coordinator.readRuntimeState(identity.legacyKey, context);
      if (isRuntimeFailure(runtime)) return runtime;
      projection = runtime;
    }
    return binding(identity, projection, summary);
  }

  async listAliveTeamBindings(
    legacyTeamNames: readonly string[],
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure> {
    if (this.purposes.current(context) !== 'runtime') return projectionPurposeInvalid();
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) return snapshot;
    const frozenAliveNames = await this.coordinator.readAliveNames(context);
    if (isAliveNamesFailure(frozenAliveNames)) return frozenAliveNames;
    if (
      legacyTeamNames.length !== frozenAliveNames.length ||
      legacyTeamNames.some((name, index) => name !== frozenAliveNames[index])
    ) {
      return corruptData();
    }
    const alive = new Set(frozenAliveNames);
    const identities = snapshot.identities.filter(
      (identity) => identity.state === 'active' && alive.has(identity.legacyKey)
    );
    const revision = parseRevision(
      `revision_${digest(
        snapshot.identities.map((identity) => ({
          identity,
          runtime: { isAlive: identity.state === 'active' && alive.has(identity.legacyKey) },
        }))
      )}`
    );
    return this.page(identities, revision, request.cursor, snapshot, (identity) =>
      Object.freeze({ teamName: identity.legacyKey, isAlive: true })
    );
  }

  private page(
    identities: readonly TeamIdentityRecord[],
    revision: Revision,
    cursorValue: ListTeamLifecycleRequest['cursor'],
    snapshot: TeamLifecycleReadSnapshot,
    projection: (identity: TeamIdentityRecord) => unknown
  ): LegacyTeamBindingPage | TeamLifecycleReadFailure {
    let offset = 0;
    if (cursorValue !== null) {
      const match = matchTeamLifecycleReadCursorForRead(cursorValue);
      if (!match) return invalidCursor();
      offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= identities.length) {
        return invalidCursor();
      }
      if (match[2] !== this.cursorDigest(revision, offset)) return snapshotChanged();
    }

    const pageIdentities = identities.slice(offset, offset + this.pageSize);
    const bindings: LegacyTeamIdentityBinding[] = [];
    for (const identity of pageIdentities) {
      const summary = snapshot.summariesByName.get(identity.legacyKey) ?? null;
      const result = binding(identity, projection(identity), summary);
      if (isFailure(result)) return result;
      bindings.push(result);
    }
    const nextOffset = offset + pageIdentities.length;
    const nextCursor =
      nextOffset < identities.length
        ? parseCursor(
            `${TEAM_LIFECYCLE_READ_CURSOR_PREFIX}_${nextOffset}_${this.cursorDigest(revision, nextOffset)}`
          )
        : null;
    return Object.freeze({
      snapshotRevision: revision,
      bindings: Object.freeze(bindings),
      nextCursor,
    });
  }

  private cursorDigest(revision: Revision, offset: number): string {
    return authorityCursorDigest(this.coordinator.authority, revision, offset);
  }
}

/** Projects tombstones and lifecycle fields from the coordinator's frozen request snapshot. */
class SnapshotLegacyDataPort implements LegacyTeamDataReadPort {
  constructor(private readonly coordinator: TeamLifecycleReadSnapshotCoordinator) {}

  async listTeams(context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) {
      throw new Error('team-lifecycle-read-snapshot-unavailable');
    }
    return snapshot.summaries;
  }

  async getTeamData(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const snapshot = await this.coordinator.readSnapshot(context);
    if (isSnapshotFailure(snapshot)) {
      throw new Error('team-lifecycle-read-snapshot-unavailable');
    }
    const identity = snapshot.identities.find(
      (candidate) => candidate.legacyKey === legacyTeamName
    );
    if (!identity) throw new Error('team-lifecycle-read-team-outside-authority');
    const summary = snapshot.summariesByName.get(legacyTeamName);
    if (!summary) throw new Error('team-lifecycle-read-summary-missing');
    const config =
      typeof summary.deletedAt === 'string'
        ? Object.freeze({ deletedAt: summary.deletedAt })
        : Object.freeze({});
    const warnings =
      summary.partialLaunchFailure === true ? Object.freeze(['degraded']) : Object.freeze([]);
    const runtime = await this.coordinator.readRuntimeState(legacyTeamName, context);
    if (isRuntimeFailure(runtime)) throw new Error('team-lifecycle-read-runtime-unavailable');
    return Object.freeze({ teamName: legacyTeamName, config, warnings, isAlive: runtime.isAlive });
  }
}

/** Returns only runtime values frozen by the coordinator for this host-owned request context. */
class SnapshotRuntimeReadPort implements LegacyTeamRuntimeReadPort {
  constructor(private readonly coordinator: TeamLifecycleReadSnapshotCoordinator) {}

  async getRuntimeState(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const runtime = await this.coordinator.readRuntimeState(legacyTeamName, context);
    if (isRuntimeFailure(runtime)) throw new Error('team-lifecycle-read-runtime-unavailable');
    return runtime;
  }

  async getAliveTeams(context: QueryContext): Promise<unknown> {
    const names = await this.coordinator.readAliveNames(context);
    if (isAliveNamesFailure(names)) throw new TeamRuntimeEvidenceUnavailableError();
    return names;
  }
}

export function createTeamLifecycleReadComposition(
  dependencies: TeamLifecycleReadCompositionDependencies
): TeamLifecycleReadComposition {
  const pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError('team-lifecycle-read-page-size-invalid');
  }
  if (typeof dependencies.nowMs !== 'function') {
    throw new TypeError('team-lifecycle-read-clock-invalid');
  }

  if (!teamLifecycleReadAuthorities.has(dependencies.authority)) {
    throw new TypeError('team-lifecycle-read-authority-invalid');
  }
  const authority = dependencies.authority;
  const coordinator = new TeamLifecycleReadSnapshotCoordinator(
    authority,
    dependencies.teamIdentities,
    dependencies.legacyData,
    dependencies.legacyRuntime,
    dependencies.nowMs
  );
  const policy = {
    isAuthorized: (context: QueryContext) => coordinator.admitContext(context),
    nowMs: dependencies.nowMs,
  };
  const purposes = new IdentityProjectionPurposeContext();
  const source = new LegacyTeamLifecycleReadSource({
    identities: new CanonicalIdentityProjectionReadPort(coordinator, pageSize, purposes),
    data: new SnapshotLegacyDataPort(coordinator),
    runtime: new SnapshotRuntimeReadPort(coordinator),
    policy,
  });
  const list = new ListTeamLifecycle(source);
  const snapshot = new GetTeamLifecycleSnapshot(source);
  const runtime = new GetRuntimeStateProjection(source);
  const alive = new ListAliveTeamProjections(source);
  const useCases = {
    list: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'lifecycle', () => list.execute(request, context)),
    },
    snapshot: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'lifecycle', () => snapshot.execute(request, context)),
    },
    runtime: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'runtime', () => runtime.execute(request, context)),
    },
    alive: {
      execute: (request: unknown, context: QueryContext) =>
        purposes.run(context, 'runtime', async () => {
          const result = await alive.execute(request, context);
          if (result.kind !== 'failure' || result.error.code !== 'unavailable') return result;
          const evidence = await coordinator.readAliveNames(context);
          return isAliveNamesFailure(evidence) ? evidence : result;
        }),
    },
  };

  return Object.freeze({
    authority,
    teamLifecycle: new TeamLifecycleReadApiAdapter(useCases),
  });
}

export function createTeamLifecycleReadHost(
  composition: TeamLifecycleReadComposition,
  createContext: (authority: TeamLifecycleReadAuthority, requestSignal: AbortSignal) => QueryContext
): TeamLifecycleReadHost {
  return Object.freeze({
    async listTeamLifecycle(
      request: unknown,
      requestSignal?: AbortSignal
    ): Promise<CanonicalListTeamLifecycleResult> {
      try {
        const signal = requestSignal ?? new AbortController().signal;
        const createdContext = createContext(composition.authority, signal);
        const context =
          createdContext.signal === signal
            ? createdContext
            : createQueryContext({ ...createdContext, signal });
        return await composition.teamLifecycle.listTeamLifecycle(
          request as ListTeamLifecycleRequest,
          context
        );
      } catch {
        return failure('internal', 'unexpected', TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.hostUnexpected);
      }
    },
  });
}

/** Production-safe placeholder until the app shell owns one unique admitted workspace binding. */
export function createUnavailableTeamLifecycleReadHost(): TeamLifecycleReadHost {
  return Object.freeze({
    async listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult> {
      const parsed = parseListTeamLifecycleRequest(request);
      if (!parsed.ok) {
        const code = parsed.error.code;
        if (code === 'not_found' || code === 'unauthenticated') {
          return failure(
            'internal',
            'unexpected',
            TEAM_LIFECYCLE_READ_DIAGNOSTIC_IDS.requestErrorInvalid
          );
        }
        return failure(code, parsed.error.reason, parsed.error.diagnosticId);
      }
      return identityUnavailable();
    },
  });
}
