import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type LegacyTeamKey,
  parseLegacyTeamKey,
  parseTeamIdentityChecksum,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  TEAM_DIRECTORY_ROOT_MARKER_FILE,
  TEAM_IDENTITY_FILE_NAME,
  type TeamAttemptArtifactOwnership,
  type TeamAttemptArtifactOwnershipRegistry,
  type TeamDirectoryRootAdmission,
  type TeamIdentityCommitOutcome,
  type TeamIdentityIntent,
  type TeamIdentityPersistence,
  type TeamIdentityPersistenceOutcome,
  type TeamIdentityPrepareOutcome,
  type TeamIdentityPublicationEvidence,
  type TeamIdentityTombstoneOutcome,
} from '@features/team-lifecycle/core/application/ports/TeamIdentityPersistence';
import {
  type AttemptOwnedArtifact,
  serializeTeamAttemptArtifactOwnership,
  TeamDirectoryLifecycleAdapter,
} from '@features/team-lifecycle/main/infrastructure/TeamDirectoryLifecycleAdapter';
import { TeamIdentityBackupCompatibility } from '@features/team-lifecycle/main/infrastructure/TeamIdentityBackupCompatibility';
import {
  checksumTeamIdentityFile,
  serializeTeamDirectoryRootMarker,
  serializeTeamIdentityFile,
  TeamIdentityFileStore,
} from '@features/team-lifecycle/main/infrastructure/TeamIdentityFileStore';
import { parseTeamId, parseWorkspaceId, type TeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listingState = vi.hoisted(() => ({ teamsRoot: '' }));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => listingState.teamsRoot,
}));

vi.mock('../../../../src/main/services/team/TeamFsWorkerClient', () => ({
  getTeamFsWorkerClient: () => ({ isAvailable: () => false }),
}));

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';

interface MarkerRoot {
  readonly path: string;
  readonly token: string;
  readonly kind: 'project' | 'runtime';
}

interface RootFixture {
  readonly project: MarkerRoot;
  readonly runtime: MarkerRoot;
  readonly teamsRoot: string;
  readonly admission: TeamDirectoryRootAdmission;
}

const rootsToClean: MarkerRoot[] = [];
const REMOVAL_QUARANTINE_DIRECTORY_NAME = '.p2-d-removal-quarantine';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function teamId(fill: string): TeamId {
  return parseTeamId(`team_${fill.repeat(32)}`);
}

async function createMarkerRoot(kind: MarkerRoot['kind']): Promise<MarkerRoot> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), `agent-teams-p2d-${kind}-`));
  const token = randomUUID().replaceAll('-', '');
  await fs.writeFile(
    path.join(rootPath, TEAM_DIRECTORY_ROOT_MARKER_FILE),
    serializeTeamDirectoryRootMarker(kind, token),
    { encoding: 'utf8', mode: 0o600 }
  );
  const root = { path: rootPath, token, kind } as const;
  rootsToClean.push(root);
  return root;
}

async function createRootFixture(): Promise<RootFixture> {
  const project = await createMarkerRoot('project');
  const runtime = await createMarkerRoot('runtime');
  const teamsRoot = path.join(runtime.path, 'teams');
  await fs.mkdir(teamsRoot, { mode: 0o700 });
  return {
    project,
    runtime,
    teamsRoot,
    admission: {
      projectRoot: {
        rootPath: project.path,
        canonicalRootPath: await fs.realpath(project.path),
        markerToken: project.token,
        kind: 'project',
      },
      runtimeRoot: {
        rootPath: runtime.path,
        canonicalRootPath: await fs.realpath(runtime.path),
        markerToken: runtime.token,
        kind: 'runtime',
      },
      teamsRootPath: teamsRoot,
    },
  };
}

async function cleanupMarkerRoot(root: MarkerRoot): Promise<void> {
  const markerPath = path.join(root.path, TEAM_DIRECTORY_ROOT_MARKER_FILE);
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
  if (
    marker.scope !== 'p2-d-team-directory' ||
    marker.kind !== root.kind ||
    marker.ownershipToken !== root.token
  ) {
    throw new Error('refusing-to-clean-unowned-p2d-root');
  }
  await fs.rm(root.path, { recursive: true, force: false });
}

afterEach(async () => {
  vi.restoreAllMocks();
  TeamConfigReader.clearCacheForTests();
  listingState.teamsRoot = '';
  for (const root of rootsToClean.splice(0).reverse()) {
    await cleanupMarkerRoot(root);
  }
});

async function replaceDirectoryWithSymlink(
  directoryPath: string,
  replacementTarget: string
): Promise<void> {
  await fs.rename(directoryPath, `${directoryPath}.swapped`);
  await fs.symlink(replacementTarget, directoryPath, 'dir');
}

async function readSingleQuarantineEntry(parentDirectory: string): Promise<string> {
  const quarantineContainer = path.join(parentDirectory, REMOVAL_QUARANTINE_DIRECTORY_NAME);
  const containerStat = await fs.stat(quarantineContainer);
  expect(containerStat.isDirectory()).toBe(true);
  const entries = await fs.readdir(quarantineContainer);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(UUID_PATTERN);
  return path.join(quarantineContainer, entries[0] ?? 'missing-quarantine-entry');
}

class MemoryIdentityPersistence
  implements TeamIdentityPersistence, TeamAttemptArtifactOwnershipRegistry
{
  readonly intents = new Map<LegacyTeamKey, TeamIdentityIntent>();
  readonly publications = new Map<TeamId, TeamIdentityPublicationEvidence>();
  readonly committed = new Map<TeamId, { checksum: string; generation: number }>();
  readonly tombstonedKeys = new Set<LegacyTeamKey>();
  readonly attemptOwnership = new Map<string, TeamAttemptArtifactOwnership>();
  readonly events: string[] = [];
  tombstoneBlocked = false;
  publicationWriteLost = false;
  beforeTombstone?: () => Promise<void>;

  async prepare(intent: TeamIdentityIntent): Promise<TeamIdentityPrepareOutcome> {
    if (this.tombstonedKeys.has(intent.legacyTeamKey)) {
      return { status: 'blocked', reason: 'legacy_key_tombstoned' };
    }
    const existing = this.intents.get(intent.legacyTeamKey);
    if (existing) {
      return existing.teamId === intent.teamId
        ? { status: 'already_prepared', intent: existing }
        : {
            status: 'blocked',
            reason: 'legacy_key_conflict',
            conflictingTeamId: existing.teamId,
          };
    }
    this.intents.set(intent.legacyTeamKey, intent);
    this.events.push('prepared');
    return { status: 'prepared', intent };
  }

  async getAuthority(request: { readonly teamId: TeamId; readonly legacyTeamKey: LegacyTeamKey }) {
    const intent = this.intents.get(request.legacyTeamKey);
    if (!intent || intent.teamId !== request.teamId) {
      return { status: 'blocked' as const, reason: 'identity_mismatch' as const };
    }
    if (this.tombstonedKeys.has(request.legacyTeamKey)) {
      return {
        status: 'found' as const,
        intent,
        authority: {
          state: 'tombstoned' as const,
          teamId: request.teamId,
          expectedChecksum: intent.expectedChecksum,
          tombstoneGeneration: 2,
          duplicateTeamIdCount: 0,
        },
      };
    }
    const committed = this.committed.get(request.teamId);
    if (committed) {
      return {
        status: 'found' as const,
        intent,
        authority: {
          state: 'committed' as const,
          teamId: request.teamId,
          expectedChecksum: parseTeamIdentityChecksum(committed.checksum),
          identityGeneration: committed.generation,
          duplicateTeamIdCount: 0,
        },
      };
    }
    const publication = this.publications.get(request.teamId);
    if (publication) {
      return {
        status: 'found' as const,
        intent,
        authority: {
          state: 'file_published' as const,
          teamId: request.teamId,
          expectedChecksum: publication.checksum,
          publication,
          duplicateTeamIdCount: 0,
        },
      };
    }
    return {
      status: 'found' as const,
      intent,
      authority: {
        state: 'prepared' as const,
        teamId: request.teamId,
        expectedChecksum: intent.expectedChecksum,
        duplicateTeamIdCount: 0,
      },
    };
  }

  async recordPublication(
    evidence: TeamIdentityPublicationEvidence
  ): Promise<TeamIdentityPersistenceOutcome> {
    const existing = this.publications.get(evidence.teamId);
    if (existing) {
      return existing.checksum === evidence.checksum
        ? { status: 'already_recorded' }
        : { status: 'blocked', reason: 'checksum_mismatch' };
    }
    if (this.publicationWriteLost) {
      return { status: 'recorded' };
    }
    this.publications.set(evidence.teamId, evidence);
    this.events.push('published');
    return { status: 'recorded' };
  }

  async commit(request: {
    readonly intent: TeamIdentityIntent;
    readonly publication: TeamIdentityPublicationEvidence;
  }): Promise<TeamIdentityCommitOutcome> {
    if (
      request.intent.teamId !== request.publication.teamId ||
      request.intent.legacyTeamKey !== request.publication.legacyTeamKey
    ) {
      return { status: 'blocked', reason: 'identity_mismatch' };
    }
    const existing = this.committed.get(request.intent.teamId);
    if (existing) {
      return {
        status: 'already_committed',
        teamId: request.intent.teamId,
        checksum: parseTeamIdentityChecksum(existing.checksum),
        identityGeneration: existing.generation,
      };
    }
    this.committed.set(request.intent.teamId, {
      checksum: request.publication.checksum,
      generation: 1,
    });
    this.events.push('committed');
    return {
      status: 'committed',
      teamId: request.intent.teamId,
      checksum: request.publication.checksum,
      identityGeneration: 1,
    };
  }

  async tombstone(request: {
    readonly teamId: TeamId;
    readonly legacyTeamKey: LegacyTeamKey;
  }): Promise<TeamIdentityTombstoneOutcome> {
    this.events.push('tombstone_requested');
    await this.beforeTombstone?.();
    if (this.tombstoneBlocked) {
      return { status: 'blocked', reason: 'identity_mismatch' };
    }
    const already = this.tombstonedKeys.has(request.legacyTeamKey);
    this.tombstonedKeys.add(request.legacyTeamKey);
    this.events.push('tombstone_durable');
    return {
      status: already ? 'already_tombstoned' : 'tombstoned',
      durability: 'durable',
      tombstoneGeneration: 2,
    };
  }

  async recordAttemptArtifactOwnership(ownership: TeamAttemptArtifactOwnership) {
    const key = this.attemptOwnershipKey(ownership);
    const existing = this.attemptOwnership.get(key);
    if (existing) {
      return serializeTeamAttemptArtifactOwnership(existing) ===
        serializeTeamAttemptArtifactOwnership(ownership)
        ? ({ status: 'already_recorded', durability: 'durable' } as const)
        : ({ status: 'blocked', reason: 'identity_mismatch' } as const);
    }
    this.attemptOwnership.set(key, ownership);
    this.events.push('attempt_ownership_durable');
    return { status: 'recorded', durability: 'durable' } as const;
  }

  async getAttemptArtifactOwnership(ownership: {
    readonly teamId: TeamId;
    readonly legacyTeamKey: LegacyTeamKey;
    readonly runId: string;
    readonly artifactRelativePath: string;
  }) {
    const existing = this.attemptOwnership.get(this.attemptOwnershipKey(ownership));
    return existing
      ? ({ status: 'found', ownership: existing } as const)
      : ({ status: 'absent' } as const);
  }

  private attemptOwnershipKey(ownership: {
    readonly teamId: TeamId;
    readonly legacyTeamKey: LegacyTeamKey;
    readonly runId: string;
    readonly artifactRelativePath: string;
  }): string {
    return [
      ownership.teamId,
      ownership.legacyTeamKey,
      ownership.runId,
      ownership.artifactRelativePath,
    ].join('\0');
  }
}

function buildIntent(key: LegacyTeamKey, id: TeamId): TeamIdentityIntent {
  const createdAt = '2026-07-16T12:00:00.000Z';
  return {
    teamId: id,
    legacyTeamKey: key,
    expectedChecksum: checksumTeamIdentityFile({
      schemaVersion: 1,
      teamId: id,
      createdAt,
    }),
    directoryFingerprint: {
      canonicalParentDigest: 'a'.repeat(64),
      relativeDirectoryKey: key,
      observedAt: '2026-07-16T12:00:00.000Z',
    },
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      bindingGeneration: 1,
      observedMountGeneration: 1,
    },
    expectedFile: 'absent',
    createdAt,
  };
}

async function writeAttemptOwnership(params: {
  readonly teamDirectory: string;
  readonly key: LegacyTeamKey;
  readonly id: TeamId;
  readonly runId: string;
  readonly relativePath: string;
}): Promise<void> {
  await fs.writeFile(
    path.join(params.teamDirectory, params.relativePath, TEAM_ATTEMPT_OWNERSHIP_FILE_NAME),
    serializeTeamAttemptArtifactOwnership({
      schemaVersion: 1,
      scope: 'p2-d-provisioning-attempt',
      teamId: params.id,
      legacyTeamKey: params.key,
      runId: params.runId,
      artifactRelativePath: params.relativePath,
      createdAt: '2026-07-16T12:00:30.000Z',
    }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
}

async function prepareAndPublish(params: {
  fixture: RootFixture;
  persistence: MemoryIdentityPersistence;
  key: LegacyTeamKey;
  id: TeamId;
}): Promise<{
  readonly store: TeamIdentityFileStore;
  readonly adapter: TeamDirectoryLifecycleAdapter;
  readonly intent: TeamIdentityIntent;
  readonly checksum: ReturnType<typeof checksumTeamIdentityFile>;
  readonly publication: TeamIdentityPublicationEvidence;
}> {
  const store = new TeamIdentityFileStore(params.fixture.admission);
  const adapter = new TeamDirectoryLifecycleAdapter(
    params.fixture.admission,
    params.persistence,
    store,
    params.persistence
  );
  const intent = buildIntent(params.key, params.id);
  await expect(
    adapter.prepareTeamDirectory({ intent, operationId: 'draft-operation-1' })
  ).resolves.toEqual({ status: 'created', teamId: params.id });
  const identity = {
    schemaVersion: 1 as const,
    teamId: params.id,
    createdAt: intent.createdAt,
  };
  const checksum = checksumTeamIdentityFile(identity);
  const published = await store.publish({
    legacyTeamKey: params.key,
    identity,
    authority: {
      state: 'prepared',
      teamId: params.id,
      expectedChecksum: checksum,
      duplicateTeamIdCount: 0,
    },
  });
  if (published.status === 'blocked') {
    throw new Error(`unexpected-publish-block:${published.reason}`);
  }
  await params.persistence.recordPublication(published.evidence);
  return { store, adapter, intent, checksum, publication: published.evidence };
}

describe('TeamIdentityFileStore', () => {
  it('publishes exclusively with durable evidence and never rewrites an existing identity', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('write-once-team');
    const id = teamId('1');
    const { store, checksum } = await prepareAndPublish({ fixture, persistence, key, id });
    const identityPath = path.join(fixture.teamsRoot, key, TEAM_IDENTITY_FILE_NAME);
    const beforeStat = await fs.stat(identityPath, { bigint: true });
    const before = await fs.readFile(identityPath, 'utf8');

    expect(before).toBe(
      serializeTeamIdentityFile({
        schemaVersion: 1,
        teamId: id,
        createdAt: '2026-07-16T12:00:00.000Z',
      })
    );
    expect(Number(beforeStat.mode & 0o777n)).toBe(0o600);

    const same = await store.publish({
      legacyTeamKey: key,
      identity: {
        schemaVersion: 1,
        teamId: id,
        createdAt: '2026-07-16T12:00:00.000Z',
      },
      authority: {
        state: 'prepared',
        teamId: id,
        expectedChecksum: checksum,
        duplicateTeamIdCount: 0,
      },
    });
    expect(same.status).toBe('already_published');
    const afterStat = await fs.stat(identityPath, { bigint: true });
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(await fs.readFile(identityPath, 'utf8')).toBe(before);

    const replacementId = teamId('2');
    const replacement = {
      schemaVersion: 1 as const,
      teamId: replacementId,
      createdAt: '2026-07-16T12:00:01.000Z',
    };
    await expect(
      store.publish({
        legacyTeamKey: key,
        identity: replacement,
        authority: {
          state: 'prepared',
          teamId: replacementId,
          expectedChecksum: checksumTeamIdentityFile(replacement),
          duplicateTeamIdCount: 0,
        },
      })
    ).resolves.toMatchObject({ status: 'blocked', reason: 'identity_mismatch' });
    expect(await fs.readFile(identityPath, 'utf8')).toBe(before);
  });

  it('fails closed for every missing, mismatch, corrupt, future and duplicate crash state', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('crash-matrix-team');
    const id = teamId('3');
    const store = new TeamIdentityFileStore(fixture.admission);
    const adapter = new TeamDirectoryLifecycleAdapter(
      fixture.admission,
      persistence,
      store,
      persistence
    );
    const intent = buildIntent(key, id);
    await adapter.prepareTeamDirectory({ intent, operationId: 'crash-operation' });
    const identity = { schemaVersion: 1 as const, teamId: id, createdAt: intent.createdAt };
    const checksum = checksumTeamIdentityFile(identity);
    const preparedAuthority = {
      state: 'prepared' as const,
      teamId: id,
      expectedChecksum: checksum,
      duplicateTeamIdCount: 0,
    };

    await expect(store.inspect(key, preparedAuthority)).resolves.toEqual({
      status: 'absent',
      capability: 'read_only',
      reason: 'awaiting_publication',
    });
    const publication = await store.publish({
      legacyTeamKey: key,
      identity,
      authority: preparedAuthority,
    });
    expect(publication.status).toBe('published');
    if (publication.status === 'blocked') throw new Error('publication unexpectedly blocked');
    const filePublishedAuthority = {
      ...preparedAuthority,
      state: 'file_published' as const,
      publication: publication.evidence,
    };
    await expect(store.inspect(key, filePublishedAuthority)).resolves.toMatchObject({
      status: 'valid',
      capability: 'read_only',
    });
    await expect(
      store.inspect(key, {
        ...preparedAuthority,
        state: 'committed',
        identityGeneration: 1,
      })
    ).resolves.toMatchObject({ status: 'valid', capability: 'read_write' });

    const identityPath = path.join(fixture.teamsRoot, key, TEAM_IDENTITY_FILE_NAME);
    await fs.rm(identityPath);
    await expect(store.inspect(key, filePublishedAuthority)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'missing_after_publication',
    });
    await expect(
      store.inspect(key, {
        ...preparedAuthority,
        state: 'committed',
        identityGeneration: 1,
      })
    ).resolves.toMatchObject({ status: 'blocked', reason: 'missing_after_commit' });

    await fs.writeFile(identityPath, '{"schemaVersion":1', { mode: 0o600 });
    await expect(store.inspect(key, preparedAuthority)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'corrupt_identity',
    });
    await fs.writeFile(identityPath, JSON.stringify(identity), 'utf8');
    await expect(store.inspect(key, preparedAuthority)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'corrupt_identity',
    });
    await fs.writeFile(
      identityPath,
      `${JSON.stringify({ schemaVersion: 2, teamId: id, createdAt: intent.createdAt })}\n`,
      'utf8'
    );
    await expect(store.inspect(key, preparedAuthority)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'future_identity',
    });

    const otherIdentity = {
      schemaVersion: 1 as const,
      teamId: teamId('4'),
      createdAt: intent.createdAt,
    };
    await fs.writeFile(identityPath, serializeTeamIdentityFile(otherIdentity), 'utf8');
    await expect(store.inspect(key, preparedAuthority)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'identity_mismatch',
    });
    await fs.writeFile(identityPath, serializeTeamIdentityFile(identity), 'utf8');
    await expect(
      store.inspect(key, {
        ...preparedAuthority,
        expectedChecksum: parseTeamIdentityChecksum('0'.repeat(64)),
      })
    ).resolves.toMatchObject({ status: 'blocked', reason: 'checksum_mismatch' });
    await expect(
      store.inspect(key, { ...preparedAuthority, duplicateTeamIdCount: 1 })
    ).resolves.toMatchObject({ status: 'blocked', reason: 'duplicate_team_id' });
  });
});

describe('descriptor-bound identity and cleanup operations', () => {
  it('caps an identity descriptor read and rejects concurrent growth before decoding', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('read-growth-team');
    const id = teamId('9');
    const { store, checksum } = await prepareAndPublish({ fixture, persistence, key, id });
    const identityPath = path.join(fixture.teamsRoot, key, TEAM_IDENTITY_FILE_NAME);

    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let grew = false;
    let consumedBytes = 0;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(`/${TEAM_IDENTITY_FILE_NAME}`)) {
        const originalRead = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
        Object.assign(handle, {
          read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            if (!grew) {
              grew = true;
              await fs.appendFile(identityPath, Buffer.alloc(8 * 1024, 0x20));
            }
            const result = await originalRead(buffer, offset, length, position);
            consumedBytes += result.bytesRead;
            return result;
          },
        });
      }
      return handle;
    });

    await expect(
      store.inspect(key, {
        state: 'committed',
        teamId: id,
        expectedChecksum: checksum,
        identityGeneration: 1,
        duplicateTeamIdCount: 0,
      })
    ).resolves.toEqual({ status: 'blocked', capability: 'blocked', reason: 'corrupt_identity' });
    expect(grew).toBe(true);
    expect(consumedBytes).toBe(4 * 1024 + 1);
  });

  it('caps an ownership descriptor read and rejects concurrent growth before cleanup decoding', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('ownership-growth-team');
    const id = teamId('a');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    const artifactDirectory = path.join(teamDirectory, 'attempts', 'run-growth');
    await fs.mkdir(artifactDirectory, { recursive: true });
    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-growth',
        artifactRelativePath: 'attempts/run-growth',
        createdAt: '2026-07-16T12:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'registered', durability: 'durable' });
    await fs.writeFile(path.join(artifactDirectory, 'bootstrap.tmp'), 'attempt-owned');
    const ownershipPath = path.join(artifactDirectory, TEAM_ATTEMPT_OWNERSHIP_FILE_NAME);

    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let grew = false;
    let consumedBytes = 0;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(`/${TEAM_ATTEMPT_OWNERSHIP_FILE_NAME}`)) {
        const originalRead = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
        Object.assign(handle, {
          read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            if (!grew) {
              grew = true;
              await fs.appendFile(ownershipPath, Buffer.alloc(8 * 1024, 0x20));
            }
            const result = await originalRead(buffer, offset, length, position);
            consumedBytes += result.bytesRead;
            return result;
          },
        });
      }
      return handle;
    });

    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-growth',
        attemptOwnedArtifacts: [{ relativePath: 'attempts/run-growth', ownerRunId: 'run-growth' }],
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'artifact_ownership_unproven' });
    expect(grew).toBe(true);
    expect(consumedBytes).toBe(4 * 1024 + 1);
    await expect(fs.stat(artifactDirectory)).resolves.toBeDefined();
  });

  it('fails closed when an ancestor is replaced during identity read', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('read-ancestor-swap-team');
    const id = teamId('e');
    const { store, checksum } = await prepareAndPublish({ fixture, persistence, key, id });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    const outsideDirectory = path.join(fixture.project.path, 'read-swap-outside');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'sentinel.txt'), 'outside-read-sentinel');

    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let swapped = false;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith(`/${TEAM_IDENTITY_FILE_NAME}`)) {
        swapped = true;
        await replaceDirectoryWithSymlink(teamDirectory, outsideDirectory);
      }
      return originalOpen(...args);
    });

    await expect(
      store.inspect(key, {
        state: 'committed',
        teamId: id,
        expectedChecksum: checksum,
        identityGeneration: 1,
        duplicateTeamIdCount: 0,
      })
    ).resolves.toMatchObject({ status: 'blocked', capability: 'blocked' });
    expect(swapped).toBe(true);
    await expect(fs.readFile(path.join(outsideDirectory, 'sentinel.txt'), 'utf8')).resolves.toBe(
      'outside-read-sentinel'
    );
  });

  it('never publishes through a replacement ancestor', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('publish-ancestor-swap-team');
    const id = teamId('f');
    const store = new TeamIdentityFileStore(fixture.admission);
    const adapter = new TeamDirectoryLifecycleAdapter(
      fixture.admission,
      persistence,
      store,
      persistence
    );
    const intent = buildIntent(key, id);
    await adapter.prepareTeamDirectory({ intent, operationId: 'publish-swap-operation' });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    const outsideDirectory = path.join(fixture.project.path, 'publish-swap-outside');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'sentinel.txt'), 'outside-publish-sentinel');

    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let swapped = false;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith(`/${TEAM_IDENTITY_FILE_NAME}`)) {
        swapped = true;
        await replaceDirectoryWithSymlink(teamDirectory, outsideDirectory);
      }
      return originalOpen(...args);
    });

    await expect(
      store.publish({
        legacyTeamKey: key,
        identity: { schemaVersion: 1, teamId: id, createdAt: intent.createdAt },
        authority: {
          state: 'prepared',
          teamId: id,
          expectedChecksum: intent.expectedChecksum,
          duplicateTeamIdCount: 0,
        },
      })
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(swapped).toBe(true);
    await expect(
      fs.stat(path.join(outsideDirectory, TEAM_IDENTITY_FILE_NAME))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(outsideDirectory, 'sentinel.txt'), 'utf8')).resolves.toBe(
      'outside-publish-sentinel'
    );
  });

  it('rechecks identity and ancestors immediately before logical attempt quarantine', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('cleanup-ancestor-swap-team');
    const id = teamId('0');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    await fs.mkdir(path.join(teamDirectory, 'attempts', 'run-swap'), { recursive: true });
    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-swap',
        artifactRelativePath: 'attempts/run-swap',
        createdAt: '2026-07-16T12:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'registered', durability: 'durable' });
    await fs.writeFile(
      path.join(teamDirectory, 'attempts', 'run-swap', 'bootstrap.tmp'),
      'attempt-owned'
    );
    const outsideDirectory = path.join(fixture.project.path, 'cleanup-swap-outside');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'sentinel.txt'), 'outside-cleanup-sentinel');

    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    let identityOpenCount = 0;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(`/${TEAM_IDENTITY_FILE_NAME}`)) {
        identityOpenCount += 1;
        if (identityOpenCount === 2) {
          await replaceDirectoryWithSymlink(teamDirectory, outsideDirectory);
        }
      }
      return originalOpen(...args);
    });

    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-swap',
        attemptOwnedArtifacts: [{ relativePath: 'attempts/run-swap', ownerRunId: 'run-swap' }],
      })
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(identityOpenCount).toBe(2);
    await expect(fs.readFile(path.join(outsideDirectory, 'sentinel.txt'), 'utf8')).resolves.toBe(
      'outside-cleanup-sentinel'
    );
  });

  it('fails closed when the validated artifact leaf is replaced at quarantine rename', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('cleanup-leaf-swap-team');
    const id = teamId('b');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    const attemptsDirectory = path.join(teamDirectory, 'attempts');
    const artifactDirectory = path.join(attemptsDirectory, 'run-leaf-swap');
    const validatedDirectory = path.join(attemptsDirectory, 'run-leaf-swap.validated');
    await fs.mkdir(artifactDirectory, { recursive: true });
    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-leaf-swap',
        artifactRelativePath: 'attempts/run-leaf-swap',
        createdAt: '2026-07-16T12:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'registered', durability: 'durable' });
    await fs.writeFile(path.join(artifactDirectory, 'validated-sentinel.txt'), 'validated-object');

    const originalRename = nodeFs.promises.rename.bind(nodeFs.promises);
    let swapped = false;
    const renameSpy = vi
      .spyOn(nodeFs.promises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (!swapped && String(source).endsWith('/run-leaf-swap')) {
          swapped = true;
          const sourcePath = String(source);
          await originalRename(sourcePath, `${sourcePath}.validated`);
          await fs.mkdir(sourcePath);
          await fs.writeFile(
            path.join(sourcePath, 'replacement-sentinel.txt'),
            'replacement-object'
          );
        }
        return originalRename(source, destination);
      });

    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-leaf-swap',
        attemptOwnedArtifacts: [
          { relativePath: 'attempts/run-leaf-swap', ownerRunId: 'run-leaf-swap' },
        ],
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'unsafe_attempt_path' });
    expect(swapped).toBe(true);
    await expect(
      fs.readFile(path.join(validatedDirectory, 'validated-sentinel.txt'), 'utf8')
    ).resolves.toBe('validated-object');
    await expect(fs.stat(artifactDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantinedDirectory = await readSingleQuarantineEntry(attemptsDirectory);
    await expect(
      fs.readFile(path.join(quarantinedDirectory, 'replacement-sentinel.txt'), 'utf8')
    ).resolves.toBe('replacement-object');
    renameSpy.mockRestore();
    const recoveredDirectory = path.join(attemptsDirectory, 'run-leaf-swap.recovered');
    await fs.rename(quarantinedDirectory, recoveredDirectory);
    await expect(
      fs.readFile(path.join(recoveredDirectory, 'replacement-sentinel.txt'), 'utf8')
    ).resolves.toBe('replacement-object');
  });
});

describe('TeamDirectoryLifecycleAdapter', () => {
  it('requires a durable file_published re-read before commit', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('durable-publication-team');
    const id = teamId('c');
    const store = new TeamIdentityFileStore(fixture.admission);
    const adapter = new TeamDirectoryLifecycleAdapter(
      fixture.admission,
      persistence,
      store,
      persistence
    );
    const intent = buildIntent(key, id);
    await adapter.prepareTeamDirectory({ intent, operationId: 'durable-publication-operation' });
    const identity = {
      schemaVersion: 1 as const,
      teamId: id,
      createdAt: intent.createdAt,
    };
    persistence.publicationWriteLost = true;
    await expect(
      adapter.publishAndCommitIdentity({ teamId: id, legacyTeamKey: key, identity })
    ).resolves.toEqual({ status: 'blocked', reason: 'publication_not_durable' });
    expect(persistence.committed.size).toBe(0);

    persistence.publicationWriteLost = false;
    await expect(
      adapter.publishAndCommitIdentity({ teamId: id, legacyTeamKey: key, identity })
    ).resolves.toMatchObject({
      status: 'committed',
      recovery: 'published_and_committed',
    });
  });

  it('resumes the durable file_published state and commits without republishing', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('published-recovery-team');
    const id = teamId('d');
    const store = new TeamIdentityFileStore(fixture.admission);
    const adapter = new TeamDirectoryLifecycleAdapter(
      fixture.admission,
      persistence,
      store,
      persistence
    );
    const intent = buildIntent(key, id);
    await expect(
      adapter.prepareTeamDirectory({ intent, operationId: 'published-recovery-operation' })
    ).resolves.toEqual({ status: 'created', teamId: id });
    const identity = {
      schemaVersion: 1 as const,
      teamId: id,
      createdAt: intent.createdAt,
    };
    const published = await store.publish({
      legacyTeamKey: key,
      identity,
      authority: {
        state: 'prepared',
        teamId: id,
        expectedChecksum: intent.expectedChecksum,
        duplicateTeamIdCount: 0,
      },
    });
    if (published.status === 'blocked') throw new Error('publication unexpectedly blocked');
    await persistence.recordPublication(published.evidence);

    await expect(
      adapter.publishAndCommitIdentity({ teamId: id, legacyTeamKey: key, identity })
    ).resolves.toEqual({
      status: 'committed',
      teamId: id,
      identityGeneration: 1,
      recovery: 'resumed_file_published',
    });
    expect(persistence.events.filter((event) => event === 'published')).toHaveLength(1);
    expect(persistence.events.filter((event) => event === 'committed')).toHaveLength(1);
    await expect(
      adapter.publishAndCommitIdentity({ teamId: id, legacyTeamKey: key, identity })
    ).resolves.toMatchObject({
      status: 'already_committed',
      recovery: 'already_committed',
    });
  });

  it('does not let caller-provided relativePath and ownerRunId forge cleanup ownership', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('attempt-cleanup-team');
    const id = teamId('5');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    const commit = await persistence.commit({ intent, publication });
    expect(commit.status).toBe('committed');
    const teamDirectory = path.join(fixture.teamsRoot, key);
    await fs.writeFile(path.join(teamDirectory, 'team.meta.json'), '{"version":1}\n', 'utf8');
    await fs.mkdir(path.join(teamDirectory, 'attempts', 'run-1'), { recursive: true });
    const artifacts: readonly AttemptOwnedArtifact[] = [
      { relativePath: 'attempts/run-1', ownerRunId: 'run-1' },
    ];

    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-1',
        attemptOwnedArtifacts: artifacts,
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'artifact_ownership_unproven' });
    await expect(fs.stat(path.join(teamDirectory, 'attempts', 'run-1'))).resolves.toBeDefined();

    await writeAttemptOwnership({
      teamDirectory,
      key,
      id,
      runId: 'run-1',
      relativePath: 'attempts/run-1',
    });
    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-1',
        attemptOwnedArtifacts: artifacts,
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'artifact_ownership_unproven' });
    await fs.rm(path.join(teamDirectory, 'attempts', 'run-1', TEAM_ATTEMPT_OWNERSHIP_FILE_NAME));
    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-1',
        artifactRelativePath: 'attempts/run-1',
        createdAt: '2026-07-16T12:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'registered', durability: 'durable' });
    await fs.writeFile(path.join(teamDirectory, 'attempts', 'run-1', 'bootstrap.tmp'), 'owned');
    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-1',
        attemptOwnedArtifacts: artifacts,
      })
    ).resolves.toEqual({
      status: 'cleaned',
      removedArtifacts: ['attempts/run-1'],
      anchorPreserved: true,
    });
    await expect(fs.stat(teamDirectory)).resolves.toBeDefined();
    await expect(fs.stat(path.join(teamDirectory, TEAM_IDENTITY_FILE_NAME))).resolves.toBeDefined();
    await expect(fs.stat(path.join(teamDirectory, 'team.meta.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(teamDirectory, 'attempts', 'run-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const attemptsDirectory = path.join(teamDirectory, 'attempts');
    const quarantinedArtifactDirectory = await readSingleQuarantineEntry(attemptsDirectory);
    await expect(
      fs.readFile(path.join(quarantinedArtifactDirectory, 'bootstrap.tmp'), 'utf8')
    ).resolves.toBe('owned');
    const recoveredArtifactDirectory = path.join(teamDirectory, 'attempts', 'run-1.recovered');
    await fs.rename(quarantinedArtifactDirectory, recoveredArtifactDirectory);
    await expect(
      fs.readFile(path.join(recoveredArtifactDirectory, 'bootstrap.tmp'), 'utf8')
    ).resolves.toBe('owned');

    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-2',
        attemptOwnedArtifacts: [{ relativePath: TEAM_IDENTITY_FILE_NAME, ownerRunId: 'run-2' }],
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'protected_artifact' });
    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-2',
        attemptOwnedArtifacts: [{ relativePath: 'cache/run-2', ownerRunId: 'run-2' }],
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'unsafe_attempt_path' });
    await expect(
      adapter.cleanupProvisioningFailure({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-2',
        attemptOwnedArtifacts: [{ relativePath: 'attempts/run-2', ownerRunId: 'other-run' }],
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'artifact_ownership_mismatch' });
  });

  it('ignores only a descriptor-proved nested quarantine container when registering pristine artifact ownership', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('artifact-quarantine-team');
    const id = teamId('4');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const attemptsDirectory = path.join(fixture.teamsRoot, key, 'attempts');
    const artifactDirectory = path.join(attemptsDirectory, 'run-nested-quarantine');
    const nestedQuarantine = path.join(artifactDirectory, REMOVAL_QUARANTINE_DIRECTORY_NAME);
    await fs.mkdir(path.join(nestedQuarantine, randomUUID()), {
      recursive: true,
      mode: 0o700,
    });

    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-nested-quarantine',
        artifactRelativePath: 'attempts/run-nested-quarantine',
        createdAt: '2026-07-16T12:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'registered', durability: 'durable' });
    await expect(
      fs.stat(path.join(artifactDirectory, TEAM_ATTEMPT_OWNERSHIP_FILE_NAME))
    ).resolves.toBeDefined();

    const invalidArtifactDirectory = path.join(attemptsDirectory, 'run-fake-quarantine');
    await fs.mkdir(invalidArtifactDirectory);
    await fs.writeFile(
      path.join(invalidArtifactDirectory, REMOVAL_QUARANTINE_DIRECTORY_NAME),
      'not-a-container',
      'utf8'
    );
    await expect(
      adapter.registerAttemptArtifactOwnership({
        teamId: id,
        legacyTeamKey: key,
        runId: 'run-fake-quarantine',
        artifactRelativePath: 'attempts/run-fake-quarantine',
        createdAt: '2026-07-16T12:00:31.000Z',
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'unsafe_attempt_path' });
    await expect(
      fs.stat(path.join(invalidArtifactDirectory, TEAM_ATTEMPT_OWNERSHIP_FILE_NAME))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a deleted team invisible to real nonrecursive listing while nested quarantine remains recoverable', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('deleted-team-key');
    const id = teamId('6');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    await fs.writeFile(
      path.join(teamDirectory, 'config.json'),
      JSON.stringify({ name: 'Deleted Team Must Stay Invisible' }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDirectory, 'recoverable-sentinel.txt'), 'recoverable-team');
    listingState.teamsRoot = fixture.teamsRoot;
    TeamConfigReader.clearCacheForTests();
    const listing = new TeamConfigReader();
    await expect(listing.listTeams()).resolves.toEqual([
      expect.objectContaining({ teamName: key, displayName: 'Deleted Team Must Stay Invisible' }),
    ]);
    persistence.beforeTombstone = async () => {
      await expect(fs.stat(teamDirectory)).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(teamDirectory, TEAM_IDENTITY_FILE_NAME))
      ).resolves.toBeDefined();
    };

    const deleteRequest = {
      teamId: id,
      legacyTeamKey: key,
      expectedIdentityGeneration: 1,
      confirmation: 'permanent_delete' as const,
      requestedAt: '2026-07-16T12:01:00.000Z',
    };
    await expect(adapter.permanentlyDelete(deleteRequest)).resolves.toEqual({
      status: 'deleted',
      tombstoneGeneration: 2,
    });
    expect(persistence.events.indexOf('tombstone_durable')).toBeGreaterThan(
      persistence.events.indexOf('tombstone_requested')
    );
    await expect(fs.stat(teamDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    persistence.beforeTombstone = undefined;
    await expect(adapter.permanentlyDelete(deleteRequest)).resolves.toEqual({
      status: 'already_deleted',
      tombstoneGeneration: 2,
    });
    TeamConfigReader.clearCacheForTests();
    await expect(listing.listTeams()).resolves.toEqual([]);
    const directEntries = await fs.readdir(fixture.teamsRoot);
    expect(directEntries).toEqual([REMOVAL_QUARANTINE_DIRECTORY_NAME]);
    await expect(
      fs.stat(path.join(fixture.teamsRoot, REMOVAL_QUARANTINE_DIRECTORY_NAME, 'config.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantinedTeamDirectory = await readSingleQuarantineEntry(fixture.teamsRoot);
    await expect(
      fs.readFile(path.join(quarantinedTeamDirectory, 'config.json'), 'utf8')
    ).resolves.toContain('Deleted Team Must Stay Invisible');
    await expect(
      fs.readFile(path.join(quarantinedTeamDirectory, 'recoverable-sentinel.txt'), 'utf8')
    ).resolves.toBe('recoverable-team');
    const recoveredTeamDirectory = path.join(fixture.project.path, `${key}.recovered`);
    await fs.rename(quarantinedTeamDirectory, recoveredTeamDirectory);
    await expect(
      fs.readFile(path.join(recoveredTeamDirectory, 'recoverable-sentinel.txt'), 'utf8')
    ).resolves.toBe('recoverable-team');
    TeamConfigReader.clearCacheForTests();
    await expect(listing.listTeams()).resolves.toEqual([]);
    await expect(persistence.prepare(buildIntent(key, teamId('7')))).resolves.toMatchObject({
      status: 'blocked',
      reason: 'legacy_key_tombstoned',
    });
  });

  it('fails closed when the validated team leaf is replaced at quarantine rename', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('delete-leaf-swap-team');
    const id = teamId('c');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    const teamDirectory = path.join(fixture.teamsRoot, key);
    const validatedDirectory = path.join(fixture.teamsRoot, `${key}.validated`);
    await fs.writeFile(path.join(teamDirectory, 'validated-sentinel.txt'), 'validated-team');

    const originalRename = nodeFs.promises.rename.bind(nodeFs.promises);
    let swapped = false;
    const renameSpy = vi
      .spyOn(nodeFs.promises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (!swapped && String(source).endsWith(`/${key}`)) {
          swapped = true;
          const sourcePath = String(source);
          await originalRename(sourcePath, `${sourcePath}.validated`);
          await fs.mkdir(sourcePath);
          await fs.writeFile(path.join(sourcePath, 'replacement-sentinel.txt'), 'replacement-team');
        }
        return originalRename(source, destination);
      });

    await expect(
      adapter.permanentlyDelete({
        teamId: id,
        legacyTeamKey: key,
        expectedIdentityGeneration: 1,
        confirmation: 'permanent_delete',
        requestedAt: '2026-07-16T12:01:30.000Z',
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'filesystem_delete_failed' });
    expect(swapped).toBe(true);
    await expect(
      fs.readFile(path.join(validatedDirectory, 'validated-sentinel.txt'), 'utf8')
    ).resolves.toBe('validated-team');
    await expect(fs.stat(teamDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantinedDirectory = await readSingleQuarantineEntry(fixture.teamsRoot);
    await expect(
      fs.readFile(path.join(quarantinedDirectory, 'replacement-sentinel.txt'), 'utf8')
    ).resolves.toBe('replacement-team');
    renameSpy.mockRestore();
    const recoveredDirectory = path.join(fixture.teamsRoot, `${key}.replacement-recovered`);
    await fs.rename(quarantinedDirectory, recoveredDirectory);
    await expect(
      fs.readFile(path.join(recoveredDirectory, 'replacement-sentinel.txt'), 'utf8')
    ).resolves.toBe('replacement-team');
  });

  it('keeps the anchor when durable tombstone persistence refuses deletion', async () => {
    const fixture = await createRootFixture();
    const persistence = new MemoryIdentityPersistence();
    const key = parseLegacyTeamKey('blocked-delete-team');
    const id = teamId('8');
    const { adapter, intent, publication } = await prepareAndPublish({
      fixture,
      persistence,
      key,
      id,
    });
    await persistence.commit({ intent, publication });
    persistence.tombstoneBlocked = true;
    const teamDirectory = path.join(fixture.teamsRoot, key);

    await expect(
      adapter.deleteDraft({
        teamId: id,
        legacyTeamKey: key,
        expectedIdentityGeneration: 1,
        confirmation: 'delete_draft',
        requestedAt: '2026-07-16T12:02:00.000Z',
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'tombstone_not_durable' });
    await expect(fs.stat(path.join(teamDirectory, TEAM_IDENTITY_FILE_NAME))).resolves.toBeDefined();
  });
});

describe('marker-owned root containment', () => {
  it('rejects unmarked, pre-existing, ambient, home and real-project roots before team access', async () => {
    const fixture = await createRootFixture();
    const id = teamId('9');
    const identity = {
      schemaVersion: 1 as const,
      teamId: id,
      createdAt: '2026-07-16T12:00:00.000Z',
    };
    const authority = {
      state: 'prepared' as const,
      teamId: id,
      expectedChecksum: checksumTeamIdentityFile(identity),
      duplicateTeamIdCount: 0,
    };

    const unmarkedPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-p2d-unmarked-'));
    const unmarkedToken = randomUUID().replaceAll('-', '');
    const unmarkedAdmission: TeamDirectoryRootAdmission = {
      ...fixture.admission,
      projectRoot: {
        rootPath: unmarkedPath,
        canonicalRootPath: await fs.realpath(unmarkedPath),
        markerToken: unmarkedToken,
        kind: 'project',
      },
    };
    await expect(
      new TeamIdentityFileStore(unmarkedAdmission).inspect(
        parseLegacyTeamKey('no-access'),
        authority
      )
    ).resolves.toMatchObject({ status: 'blocked', reason: 'root_not_admitted' });
    await fs.writeFile(
      path.join(unmarkedPath, TEAM_DIRECTORY_ROOT_MARKER_FILE),
      serializeTeamDirectoryRootMarker('project', unmarkedToken),
      { encoding: 'utf8', mode: 0o600 }
    );
    rootsToClean.push({ path: unmarkedPath, token: unmarkedToken, kind: 'project' });

    for (const forbiddenRoot of [os.tmpdir(), os.homedir(), process.cwd()]) {
      const forbiddenAdmission: TeamDirectoryRootAdmission = {
        ...fixture.admission,
        projectRoot: {
          rootPath: forbiddenRoot,
          canonicalRootPath: path.resolve(forbiddenRoot),
          markerToken: unmarkedToken,
          kind: 'project',
        },
      };
      await expect(
        new TeamIdentityFileStore(forbiddenAdmission).inspect(
          parseLegacyTeamKey('forbidden-root'),
          authority
        )
      ).resolves.toMatchObject({ status: 'blocked', reason: 'root_not_admitted' });
    }
  });

  it('rejects a symlink-escaped team directory without touching the outside marker', async () => {
    const fixture = await createRootFixture();
    const key = parseLegacyTeamKey('symlink-escape-team');
    const outsideDirectory = path.join(fixture.project.path, 'outside-team');
    const outsideSentinel = path.join(outsideDirectory, 'sentinel.txt');
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(outsideSentinel, 'outside-must-remain', 'utf8');
    await fs.symlink(outsideDirectory, path.join(fixture.teamsRoot, key), 'dir');
    const id = teamId('a');
    const identity = {
      schemaVersion: 1 as const,
      teamId: id,
      createdAt: '2026-07-16T12:00:00.000Z',
    };

    await expect(
      new TeamIdentityFileStore(fixture.admission).inspect(key, {
        state: 'prepared',
        teamId: id,
        expectedChecksum: checksumTeamIdentityFile(identity),
        duplicateTeamIdCount: 0,
      })
    ).resolves.toMatchObject({ status: 'blocked', reason: 'unsafe_team_directory' });
    await expect(fs.readFile(outsideSentinel, 'utf8')).resolves.toBe('outside-must-remain');
  });
});

describe('TeamIdentityBackupCompatibility', () => {
  it('keeps canonical and legacy identity distinct in async and shutdown inventories', () => {
    const compatibility = new TeamIdentityBackupCompatibility();
    const canonicalIdentity = {
      teamId: teamId('b'),
      checksum: parseTeamIdentityChecksum('c'.repeat(64)),
      identityFile: TEAM_IDENTITY_FILE_NAME,
    } as const;
    const input = {
      configReady: false,
      discoveredRelativePaths: ['members.meta.json', 'config.json'],
      canonicalIdentity,
      legacyIdentity: {
        identityId: 'legacy-manifest-correlation',
        backupIdentityId: 'legacy-config-correlation',
      },
    } as const;

    for (const inventory of [
      compatibility.buildAsyncInventory(input),
      compatibility.buildShutdownSyncInventory(input),
    ]) {
      expect(inventory.classification).toBe('legacy_unverified');
      expect(inventory.recoveryCapability).toBe('not_verified');
      expect(inventory.relativePaths[0]).toBe(TEAM_IDENTITY_FILE_NAME);
      expect(inventory.canonicalIdentity.teamId).toBe(canonicalIdentity.teamId);
      expect(inventory.legacyIdentity?.identityId).not.toBe(canonicalIdentity.teamId);
      expect(inventory.canonicalIdentityIncludedRegardlessOfConfigReadiness).toBe(true);
    }
  });
});
