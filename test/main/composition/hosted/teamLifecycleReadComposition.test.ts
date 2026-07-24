import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  type ListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadAuthority,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
  createUnavailableTeamLifecycleReadHost,
  type TeamLifecycleReadAuthority,
  TeamLifecycleReadSnapshotCoordinator,
} from '@main/composition/hosted/teamLifecycleReadComposition';
import {
  createQueryContext,
  parseBootId,
  parseCursor,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_MS = Date.parse('2026-07-18T10:00:00.000Z');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const FOREIGN_WORKSPACE_ID = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
let boundaryRequestSequence = 0;
const filesystemRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    filesystemRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

interface AuthorityOverrides {
  readonly actorId?: string;
  readonly authorizedScope?: string;
  readonly workspaceId?: typeof WORKSPACE_ID;
  readonly workspaceGeneration?: number;
  readonly deploymentId?: string;
  readonly bootId?: string;
}

function authority(overrides: AuthorityOverrides = {}): TeamLifecycleReadAuthority {
  const workspaceId = overrides.workspaceId ?? WORKSPACE_ID;
  const workspaceGeneration = overrides.workspaceGeneration ?? 1;
  const bootId = overrides.bootId ?? 'boot_team-lifecycle-read-composition';
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-${workspaceId}`,
    workspaceId,
    displayName: 'Team lifecycle read composition test',
    registrationRevision: 1,
    declaredRootHash: '3'.repeat(64),
    enabled: true,
  });
  const mountBinding = new WorkspaceMountBinding({
    registration,
    bootId: parseBootId(bootId),
    mountGeneration: workspaceGeneration,
    previousMountGeneration: workspaceGeneration > 1 ? workspaceGeneration - 1 : undefined,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'healthy',
    allowedOperations: [],
  });
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: overrides.deploymentId ?? 'deployment_team-lifecycle-read-composition',
    bootId,
    claudeRoot: { kind: 'claude', reference: 'runtime://claude' },
    appDataRoot: { kind: 'app-data', reference: 'runtime://app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: 'runtime://workspace' }],
    tempRoot: { kind: 'temp', reference: 'runtime://temp' },
    logsRoot: { kind: 'logs', reference: 'runtime://logs' },
  });
  return createTeamLifecycleReadAuthority({
    actorId: overrides.actorId ?? 'actor_team-lifecycle-read-composition',
    authorizedScope: overrides.authorizedScope ?? 'scope_team-lifecycle.read',
    mountBinding,
    runtimeInstance,
  });
}

function identity(
  fill: string,
  state: TeamIdentityRecord['state'] = 'active',
  workspaceBinding: TeamIdentityRecord['workspaceBinding'] = {
    workspaceId: WORKSPACE_ID,
    generation: 1,
  }
): TeamIdentityRecord {
  return parseTeamIdentityRecord({
    teamId: parseTeamId(`team_${fill.repeat(32)}`),
    state,
    legacyKey: `team-${fill}`,
    directoryFingerprint: fill.repeat(64),
    workspaceBinding,
    adoptionIntentId: state === 'reserved' ? null : `adoption_${fill.repeat(32)}`,
    identityChecksum:
      state === 'file_published' || state === 'active' || state === 'tombstoned'
        ? fill.repeat(64)
        : null,
    createdAt: '2026-07-18T09:59:00.000Z',
    activatedAt: state === 'active' || state === 'tombstoned' ? '2026-07-18T09:59:30.000Z' : null,
    tombstonedAt: state === 'tombstoned' ? '2026-07-18T09:59:45.000Z' : null,
  });
}

function listRequest(overrides: Partial<ListTeamLifecycleRequest> = {}): ListTeamLifecycleRequest {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    cursor: null,
    expectedRevision: null,
    ...overrides,
  };
}

function boundaryContext(
  readAuthority: TeamLifecycleReadAuthority,
  signal: AbortSignal,
  deadlineAtMs = NOW_MS + 10_000
): QueryContext {
  return createQueryContext({
    actorId: readAuthority.actorId,
    sessionId: 'session_team-lifecycle-read-boundary',
    deploymentId: readAuthority.deploymentId,
    bootId: readAuthority.bootId,
    requestId: `request_team-lifecycle-read-boundary-${++boundaryRequestSequence}`,
    authorizedScope: readAuthority.authorizedScope,
    deadlineAtMs,
    signal,
  });
}

interface HarnessOptions {
  readonly authority?: TeamLifecycleReadAuthority;
  readonly identities: readonly TeamIdentityRecord[] | null;
  readonly summaries?: readonly Record<string, unknown>[];
  readonly pageSize?: number;
  readonly beforeIdentityRead?: () => void;
  readonly beforeSummaryRead?: () => void;
  readonly beforeRuntimeRead?: () => void;
  readonly beforeAliveRead?: () => void;
  readonly nowMs?: () => number;
}

function createHarness(options: HarnessOptions) {
  let identities = options.identities;
  let summaries =
    options.summaries ?? (identities ?? []).map((value) => ({ teamName: value.legacyKey }));
  let runtimeAlive = false;
  let contextSequence = 0;
  const readAuthority = options.authority ?? authority();
  const listTeamIdentities = vi.fn(() => {
    options.beforeIdentityRead?.();
    return Promise.resolve(identities ?? []);
  });
  const gateway: TeamIdentityReadGateway | null = identities
    ? {
        listTeamIdentities,
        getTeamIdentity: vi.fn(() => Promise.resolve(null)),
      }
    : null;
  const getTeamData = vi.fn((teamName: string) =>
    Promise.resolve({ teamName, config: {}, warnings: [], isAlive: false })
  );
  const getRuntimeState = vi.fn((teamName: string) => {
    options.beforeRuntimeRead?.();
    return Promise.resolve({ teamName, isAlive: runtimeAlive });
  });
  const listTeams = vi.fn(() => {
    options.beforeSummaryRead?.();
    return Promise.resolve(summaries);
  });
  const getAliveTeams = vi.fn(() => {
    options.beforeAliveRead?.();
    return Promise.resolve(runtimeAlive ? ['team-a'] : []);
  });
  const composition = createTeamLifecycleReadComposition({
    authority: readAuthority,
    teamIdentities: gateway,
    legacyData: {
      listTeams,
      getTeamData,
    },
    legacyRuntime: {
      getRuntimeState,
      getAliveTeams,
    },
    nowMs: options.nowMs ?? (() => NOW_MS),
    pageSize: options.pageSize,
  });
  const createContext = (
    _authority: TeamLifecycleReadAuthority = readAuthority,
    requestSignal: AbortSignal = new AbortController().signal
  ): QueryContext =>
    createQueryContext({
      actorId: readAuthority.actorId,
      sessionId: 'session_team-lifecycle-read-composition',
      deploymentId: readAuthority.deploymentId,
      bootId: readAuthority.bootId,
      requestId: `request_team-lifecycle-read-composition-${++contextSequence}`,
      authorizedScope: readAuthority.authorizedScope,
      deadlineAtMs: NOW_MS + 10_000,
      signal: requestSignal,
    });
  const host = createTeamLifecycleReadHost(composition, createContext);
  return {
    authority: readAuthority,
    composition,
    createContext,
    getAliveTeams,
    getRuntimeState,
    getTeamData,
    host,
    listTeamIdentities,
    listTeams,
    replaceIdentities(next: readonly TeamIdentityRecord[]) {
      identities = next;
    },
    replaceSummaries(next: readonly Record<string, unknown>[]) {
      summaries = next;
    },
    setRuntimeAlive(next: boolean) {
      runtimeAlive = next;
    },
  };
}

describe('teamLifecycleReadComposition semantic isolation', () => {
  it('keeps the fail-closed production host strict before reporting authority unavailable', async () => {
    const host = createUnavailableTeamLifecycleReadHost();

    await expect(
      host.listTeamLifecycle({ ...listRequest(), actorId: 'actor_wire' })
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    await expect(host.listTeamLifecycle(listRequest())).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'unavailable', reason: 'identity_storage_unavailable' },
    });
  });

  it('threads the host-owned request signal into the use-case QueryContext', async () => {
    const controller = new AbortController();
    const harness = createHarness({
      identities: [identity('a')],
      beforeSummaryRead: () => controller.abort(),
    });

    await expect(
      harness.host.listTeamLifecycle(listRequest(), controller.signal)
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled', reason: 'request_cancelled' },
    });
    expect(harness.listTeams).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it.each([
    ['actor', { actorId: 'actor_other' }],
    ['scope', { authorizedScope: 'scope_other.read' }],
    ['workspace', { workspaceId: FOREIGN_WORKSPACE_ID }],
    ['deployment', { deploymentId: 'deployment_other' }],
    ['boot', { bootId: 'boot_other' }],
  ] as const)('rejects cross-%s cursor replay', async (_dimension, overrides) => {
    const source = createHarness({
      identities: [identity('a'), identity('b')],
      pageSize: 1,
    });
    const first = await source.host.listTeamLifecycle(listRequest());
    if (first.kind !== 'success' || first.nextCursor === null) {
      throw new Error('expected source cursor');
    }
    expect(first.nextCursor).toMatch(/^cursor_team_lifecycle_read_/);

    const targetAuthority = authority(overrides);
    const targetBinding = {
      workspaceId: targetAuthority.workspaceId,
      generation: targetAuthority.workspaceGeneration,
    };
    const target = createHarness({
      authority: targetAuthority,
      identities: [identity('a', 'active', targetBinding), identity('b', 'active', targetBinding)],
      pageSize: 1,
    });

    await expect(
      target.host.listTeamLifecycle(listRequest({ cursor: first.nextCursor }))
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
  });

  it('accepts the read-only compatibility cursor while emitting only stable cursors', async () => {
    const harness = createHarness({
      identities: [identity('a'), identity('b')],
      pageSize: 1,
    });
    const first = await harness.host.listTeamLifecycle(listRequest());
    if (first.kind !== 'success' || first.nextCursor === null) {
      throw new Error('expected stable source cursor');
    }

    const compatibilityCursor = parseCursor(
      first.nextCursor.replace('cursor_team_lifecycle_read_', 'cursor_phase2_')
    );
    await expect(
      harness.host.listTeamLifecycle(listRequest({ cursor: compatibilityCursor }))
    ).resolves.toMatchObject({
      kind: 'success',
      items: [{ teamId: parseTeamId(`team_${'b'.repeat(32)}`) }],
      nextCursor: null,
    });
    expect(first.nextCursor).toMatch(/^cursor_team_lifecycle_read_/);
  });

  it('changes item and snapshot revisions for lifecycle-only summary changes and stales cursors', async () => {
    const harness = createHarness({
      identities: [identity('a'), identity('b')],
      summaries: [{ teamName: 'team-a' }, { teamName: 'team-b' }],
      pageSize: 1,
    });
    const first = await harness.host.listTeamLifecycle(listRequest());
    if (first.kind !== 'success' || first.nextCursor === null) {
      throw new Error('expected paged lifecycle result');
    }

    harness.replaceSummaries([
      { teamName: 'team-a', partialLaunchFailure: true },
      { teamName: 'team-b' },
    ]);
    const changed = await harness.host.listTeamLifecycle(listRequest());
    if (changed.kind !== 'success') throw new Error('expected changed lifecycle result');

    expect(changed.snapshotRevision).not.toBe(first.snapshotRevision);
    expect(changed.items[0].revision).not.toBe(first.items[0].revision);
    expect(changed.items[0].lifecycle).toBe('degraded');
    await expect(
      harness.host.listTeamLifecycle(listRequest({ cursor: first.nextCursor }))
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
  });

  it('keeps tombstones frozen when identity storage mutates between identity and summary reads', async () => {
    let mutated = false;
    const harness = createHarness({
      identities: [identity('a')],
      summaries: [{ teamName: 'team-a' }],
      beforeSummaryRead: () => {
        if (mutated) return;
        mutated = true;
        harness.replaceIdentities([identity('a', 'tombstoned')]);
      },
    });

    await expect(harness.host.listTeamLifecycle(listRequest())).resolves.toMatchObject({
      kind: 'success',
      items: [{ lifecycle: 'ready' }],
    });
    await expect(harness.host.listTeamLifecycle(listRequest())).resolves.toMatchObject({
      kind: 'success',
      items: [{ lifecycle: 'deleted' }],
    });
    expect(harness.listTeamIdentities).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['null binding', identity('c', 'active', null), { code: 'internal', reason: 'corrupt_source' }],
    [
      'stale local generation',
      identity('c', 'active', { workspaceId: WORKSPACE_ID, generation: 2 }),
      { code: 'conflict', reason: 'snapshot_changed' },
    ],
  ] as const)('fails closed for %s', async (_name, invalidIdentity, error) => {
    const harness = createHarness({ identities: [identity('a'), invalidIdentity] });

    await expect(harness.host.listTeamLifecycle(listRequest())).resolves.toMatchObject({
      kind: 'failure',
      error,
    });
  });

  it('uses the frozen summary for entity data and gives list/entity the same projection revision', async () => {
    const team = identity('a');
    const harness = createHarness({
      identities: [team],
      summaries: [{ teamName: 'team-a', partialLaunchFailure: true }],
    });
    const listed = await harness.host.listTeamLifecycle(listRequest());
    if (listed.kind !== 'success') throw new Error('expected lifecycle list');

    const entity = await harness.composition.teamLifecycle.getTeamLifecycleSnapshot(
      {
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        workspaceId: WORKSPACE_ID,
        teamId: team.teamId,
        expectedRevision: null,
      },
      harness.createContext()
    );

    expect(entity).toMatchObject({
      kind: 'success',
      snapshot: { lifecycle: 'degraded', revision: listed.items[0].revision },
    });
    expect(harness.getTeamData).not.toHaveBeenCalled();
  });

  it('binds runtime projection revisions to the frozen runtime value', async () => {
    const team = identity('a');
    const harness = createHarness({ identities: [team] });
    const entityRequest = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      teamId: team.teamId,
      expectedRevision: null,
    } as const;
    const stopped = await harness.composition.teamLifecycle.getRuntimeStateProjection(
      entityRequest,
      harness.createContext()
    );
    if (stopped.kind !== 'success') throw new Error('expected stopped runtime projection');

    harness.setRuntimeAlive(true);
    const running = await harness.composition.teamLifecycle.getRuntimeStateProjection(
      entityRequest,
      harness.createContext()
    );
    if (running.kind !== 'success') throw new Error('expected running runtime projection');

    expect(stopped.projection.isAlive).toBe(false);
    expect(running.projection.isAlive).toBe(true);
    expect(running.projection.revision).not.toBe(stopped.projection.revision);
    await expect(
      harness.composition.teamLifecycle.getRuntimeStateProjection(
        { ...entityRequest, expectedRevision: stopped.projection.revision },
        harness.createContext()
      )
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
    expect(harness.getRuntimeState).toHaveBeenCalledTimes(3);
  });

  it('selects lifecycle and runtime projections through the single canonical source', async () => {
    const team = identity('a');
    const harness = createHarness({
      identities: [team],
      summaries: [{ teamName: 'team-a' }],
    });
    const entityRequest = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      teamId: team.teamId,
      expectedRevision: null,
    } as const;

    const lifecycleBefore = await harness.composition.teamLifecycle.getTeamLifecycleSnapshot(
      entityRequest,
      harness.createContext()
    );
    const runtimeStopped = await harness.composition.teamLifecycle.getRuntimeStateProjection(
      entityRequest,
      harness.createContext()
    );
    harness.setRuntimeAlive(true);
    const lifecycleAfterRuntimeChange =
      await harness.composition.teamLifecycle.getTeamLifecycleSnapshot(
        entityRequest,
        harness.createContext()
      );
    const runtimeRunning = await harness.composition.teamLifecycle.getRuntimeStateProjection(
      entityRequest,
      harness.createContext()
    );
    harness.replaceSummaries([{ teamName: 'team-a', partialLaunchFailure: true }]);
    const runtimeAfterLifecycleChange =
      await harness.composition.teamLifecycle.getRuntimeStateProjection(
        entityRequest,
        harness.createContext()
      );
    const lifecycleAfterSummaryChange =
      await harness.composition.teamLifecycle.getTeamLifecycleSnapshot(
        entityRequest,
        harness.createContext()
      );

    if (
      lifecycleBefore.kind !== 'success' ||
      lifecycleAfterRuntimeChange.kind !== 'success' ||
      lifecycleAfterSummaryChange.kind !== 'success' ||
      runtimeStopped.kind !== 'success' ||
      runtimeRunning.kind !== 'success' ||
      runtimeAfterLifecycleChange.kind !== 'success'
    ) {
      throw new Error('expected lifecycle and runtime projection successes');
    }
    expect(lifecycleAfterRuntimeChange.snapshot.revision).toBe(lifecycleBefore.snapshot.revision);
    expect(lifecycleAfterSummaryChange.snapshot.revision).not.toBe(
      lifecycleBefore.snapshot.revision
    );
    expect(runtimeRunning.projection.revision).not.toBe(runtimeStopped.projection.revision);
    expect(runtimeAfterLifecycleChange.projection.revision).toBe(
      runtimeRunning.projection.revision
    );
  });
});

describe('teamLifecycleReadComposition coordinator cancellation boundaries', () => {
  it('rechecks cancellation immediately after failed identity port I/O', async () => {
    const controller = new AbortController();
    const readAuthority = authority();
    const coordinator = new TeamLifecycleReadSnapshotCoordinator(
      readAuthority,
      {
        listTeamIdentities: async () => {
          controller.abort();
          throw new Error('identity-failed');
        },
        getTeamIdentity: () => Promise.resolve(null),
      },
      {
        listTeams: () => Promise.resolve([]),
        getTeamData: () => Promise.resolve(null),
      },
      {
        getRuntimeState: () => Promise.resolve(null),
        getAliveTeams: () => Promise.resolve([]),
      },
      () => NOW_MS
    );

    await expect(
      coordinator.readSnapshot(boundaryContext(readAuthority, controller.signal))
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'cancelled' } });
  });

  it.each(['abort', 'deadline'] as const)(
    'blocks identity I/O when the request has already reached its %s boundary',
    async (mode) => {
      const controller = new AbortController();
      let nowMs = NOW_MS;
      const harness = createHarness({ identities: [identity('a')], nowMs: () => nowMs });
      if (mode === 'abort') controller.abort();
      else nowMs = NOW_MS + 1;

      await expect(
        harness.composition.teamLifecycle.listTeamLifecycle(
          listRequest(),
          boundaryContext(harness.authority, controller.signal, NOW_MS + 1)
        )
      ).resolves.toMatchObject({
        kind: 'failure',
        error: {
          code: 'cancelled',
          reason: mode === 'abort' ? 'request_cancelled' : 'deadline_exceeded',
        },
      });
      expect(harness.listTeamIdentities).not.toHaveBeenCalled();
      expect(harness.listTeams).not.toHaveBeenCalled();
    }
  );

  it.each(['abort', 'deadline'] as const)(
    'rechecks %s after identity I/O and performs no legacy-data I/O',
    async (mode) => {
      const controller = new AbortController();
      let nowMs = NOW_MS;
      const cancel = () => {
        if (mode === 'abort') controller.abort();
        else nowMs = NOW_MS + 1;
      };
      const harness = createHarness({
        identities: [identity('a')],
        beforeIdentityRead: cancel,
        nowMs: () => nowMs,
      });

      await expect(
        harness.composition.teamLifecycle.listTeamLifecycle(
          listRequest(),
          boundaryContext(harness.authority, controller.signal, NOW_MS + 1)
        )
      ).resolves.toMatchObject({
        kind: 'failure',
        error: { code: 'cancelled' },
      });
      expect(harness.listTeamIdentities).toHaveBeenCalledTimes(1);
      expect(harness.listTeams).not.toHaveBeenCalled();
      expect(harness.getRuntimeState).not.toHaveBeenCalled();
      expect(harness.getAliveTeams).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['runtime state', 'abort'],
    ['runtime state', 'deadline'],
    ['alive runtime', 'abort'],
    ['alive runtime', 'deadline'],
  ] as const)(
    'rechecks %s %s after legacy-data I/O and performs no runtime I/O',
    async (operation, mode) => {
      const controller = new AbortController();
      let nowMs = NOW_MS;
      const cancel = () => {
        if (mode === 'abort') controller.abort();
        else nowMs = NOW_MS + 1;
      };
      const team = identity('a');
      const harness = createHarness({
        identities: [team],
        beforeSummaryRead: cancel,
        nowMs: () => nowMs,
      });
      const context = boundaryContext(harness.authority, controller.signal, NOW_MS + 1);
      const result =
        operation === 'runtime state'
          ? harness.composition.teamLifecycle.getRuntimeStateProjection(
              {
                schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
                workspaceId: WORKSPACE_ID,
                teamId: team.teamId,
                expectedRevision: null,
              },
              context
            )
          : harness.composition.teamLifecycle.listAliveTeamProjections(
              {
                schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
                cursor: null,
                expectedRevision: null,
              },
              context
            );

      await expect(result).resolves.toMatchObject({
        kind: 'failure',
        error: { code: 'cancelled' },
      });
      expect(harness.listTeamIdentities).toHaveBeenCalledTimes(1);
      expect(harness.listTeams).toHaveBeenCalledTimes(1);
      expect(harness.getRuntimeState).not.toHaveBeenCalled();
      expect(harness.getAliveTeams).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['runtime state', 'abort'],
    ['runtime state', 'deadline'],
    ['alive runtime', 'abort'],
    ['alive runtime', 'deadline'],
  ] as const)('blocks %s I/O when %s is reached after snapshot I/O', async (operation, mode) => {
    const controller = new AbortController();
    let nowMs = NOW_MS;
    const readAuthority = authority();
    const team = identity('a');
    const listTeamIdentities = vi.fn(() => Promise.resolve([team]));
    const listTeams = vi.fn(() => Promise.resolve([{ teamName: team.legacyKey }]));
    const getRuntimeState = vi.fn(() =>
      Promise.resolve({ teamName: team.legacyKey, isAlive: false })
    );
    const getAliveTeams = vi.fn(() => Promise.resolve([]));
    const coordinator = new TeamLifecycleReadSnapshotCoordinator(
      readAuthority,
      { listTeamIdentities, getTeamIdentity: vi.fn(() => Promise.resolve(null)) },
      { listTeams, getTeamData: vi.fn(() => Promise.resolve(null)) },
      { getRuntimeState, getAliveTeams },
      () => nowMs
    );
    const context = boundaryContext(readAuthority, controller.signal, NOW_MS + 1);

    await expect(coordinator.readSnapshot(context)).resolves.not.toHaveProperty('kind');
    if (mode === 'abort') controller.abort();
    else nowMs = NOW_MS + 1;

    const result =
      operation === 'runtime state'
        ? coordinator.readRuntimeState(team.legacyKey, context)
        : coordinator.readAliveNames(context);
    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled' },
    });
    expect(listTeamIdentities).toHaveBeenCalledTimes(1);
    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(getRuntimeState).not.toHaveBeenCalled();
    expect(getAliveTeams).not.toHaveBeenCalled();
  });

  it.each([
    ['runtime state', 'abort'],
    ['runtime state', 'deadline'],
    ['alive runtime', 'abort'],
    ['alive runtime', 'deadline'],
  ] as const)('returns cancellation reached during %s %s I/O', async (operation, mode) => {
    const controller = new AbortController();
    let nowMs = NOW_MS;
    const cancel = () => {
      if (mode === 'abort') controller.abort();
      else nowMs = NOW_MS + 1;
    };
    const team = identity('a');
    const harness = createHarness({
      identities: [team],
      beforeRuntimeRead: operation === 'runtime state' ? cancel : undefined,
      beforeAliveRead: operation === 'alive runtime' ? cancel : undefined,
      nowMs: () => nowMs,
    });
    const context = boundaryContext(harness.authority, controller.signal, NOW_MS + 1);
    const result =
      operation === 'runtime state'
        ? harness.composition.teamLifecycle.getRuntimeStateProjection(
            {
              schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
              workspaceId: WORKSPACE_ID,
              teamId: team.teamId,
              expectedRevision: null,
            },
            context
          )
        : harness.composition.teamLifecycle.listAliveTeamProjections(
            {
              schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
              cursor: null,
              expectedRevision: null,
            },
            context
          );

    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled' },
    });
    expect(harness.getRuntimeState).toHaveBeenCalledTimes(operation === 'runtime state' ? 1 : 0);
    expect(harness.getAliveTeams).toHaveBeenCalledTimes(operation === 'alive runtime' ? 1 : 0);
  });
});

describe('mount-binding-scoped hosted read ports', () => {
  it('reads only identity-admitted legacy keys through the narrow read-only source', async () => {
    const readAuthority = authority();
    const registration = new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: 'registration-scoped-read',
      workspaceId: WORKSPACE_ID,
      displayName: 'Scoped read',
      registrationRevision: 1,
      declaredRootHash: '4'.repeat(64),
      enabled: true,
    });
    const mountBinding = new WorkspaceMountBinding({
      registration,
      bootId: readAuthority.bootId,
      mountGeneration: 1,
      declaredRootHash: registration.declaredRootHash,
      observedAt: NOW_MS,
      health: 'read-only',
      allowedOperations: [],
    });
    const runtimeInstance = createRuntimeInstanceContext({
      deploymentId: readAuthority.deploymentId,
      bootId: readAuthority.bootId,
      claudeRoot: { kind: 'claude', reference: '/runtime/team-lifecycle-read/claude' },
      appDataRoot: {
        kind: 'app-data',
        reference: '/runtime/team-lifecycle-read/app-data',
      },
      workspaceRoots: [{ kind: 'workspace', reference: '/runtime/team-lifecycle-read/workspace' }],
      tempRoot: { kind: 'temp', reference: '/runtime/team-lifecycle-read/temp' },
      logsRoot: { kind: 'logs', reference: '/runtime/team-lifecycle-read/logs' },
    });
    const local = identity('a');
    const foreign = identity('b', 'active', {
      workspaceId: FOREIGN_WORKSPACE_ID,
      generation: 1,
    });
    let identityValues = [local, foreign];
    const listTeamIdentities = vi.fn(() => Promise.resolve(identityValues));
    const readTeamSummary = vi.fn(
      async (input: { readonly claudeRoot: string; readonly identity: TeamIdentityRecord }) =>
        Object.freeze({ teamName: input.identity.legacyKey })
    );
    const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
      authority: readAuthority,
      mountBinding,
      runtimeInstance,
      teamIdentities: {
        listTeamIdentities,
        getTeamIdentity: vi.fn(() => Promise.resolve(null)),
      },
      nowMs: () => NOW_MS,
      teamSummarySource: { readTeamSummary },
    });
    const composition = createTeamLifecycleReadComposition({
      authority: readAuthority,
      ...readPorts,
      nowMs: () => NOW_MS,
    });

    await expect(
      composition.teamLifecycle.listTeamLifecycle(
        listRequest(),
        boundaryContext(readAuthority, new AbortController().signal)
      )
    ).resolves.toMatchObject({
      kind: 'success',
      items: [{ workspaceId: WORKSPACE_ID, teamId: local.teamId }],
    });
    expect(listTeamIdentities).toHaveBeenCalledTimes(1);
    expect(readTeamSummary).toHaveBeenCalledTimes(1);
    expect(readTeamSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeRoot: '/runtime/team-lifecycle-read/claude',
        identity: local,
      })
    );
    expect(readTeamSummary).not.toHaveBeenCalledWith(
      expect.objectContaining({ identity: foreign })
    );

    identityValues = [identity('c', 'active', { workspaceId: WORKSPACE_ID, generation: 2 })];
    await expect(readPorts.teamIdentities.listTeamIdentities()).rejects.toThrow(
      'team-lifecycle-read-identity-binding-generation-invalid'
    );
    expect(readTeamSummary).toHaveBeenCalledTimes(1);
  });

  async function createFilesystemHarness(
    options: {
      readonly configBytes?: Buffer;
      readonly configSymlinkTarget?: string;
      readonly identityFileTeamId?: TeamIdentityRecord['teamId'];
      readonly nowMs?: () => number;
    } = {}
  ) {
    const claudeRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'team-lifecycle-read-config-')
    );
    filesystemRoots.push(claudeRoot);
    const teamRoot = path.join(claudeRoot, 'teams', 'team-a');
    await fs.promises.mkdir(teamRoot, { recursive: true });
    const storedTeam = identity('a');
    const canonicalTeamRoot = await fs.promises.realpath(teamRoot);
    const teamRootStat = await fs.promises.lstat(canonicalTeamRoot, { bigint: true });
    const directoryFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          canonicalPath: canonicalTeamRoot,
          device: teamRootStat.dev.toString(),
          inode: teamRootStat.ino.toString(),
        }),
        'utf8'
      )
      .digest('hex');
    const serializedIdentity = `${JSON.stringify(
      {
        schemaVersion: 1,
        teamId: options.identityFileTeamId ?? storedTeam.teamId,
        createdAt: storedTeam.createdAt,
      },
      null,
      2
    )}\n`;
    const team = parseTeamIdentityRecord({
      ...storedTeam,
      directoryFingerprint,
      identityChecksum: createHash('sha256').update(serializedIdentity, 'utf8').digest('hex'),
    });
    await fs.promises.writeFile(path.join(teamRoot, 'team.identity.json'), serializedIdentity);
    const configPath = path.join(teamRoot, 'config.json');
    if (options.configSymlinkTarget) {
      await fs.promises.symlink(options.configSymlinkTarget, configPath);
    } else {
      await fs.promises.writeFile(
        configPath,
        options.configBytes ?? Buffer.from(JSON.stringify({ name: 'team-a' }))
      );
    }

    const registration = new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: `registration-config-${filesystemRoots.length}`,
      workspaceId: WORKSPACE_ID,
      displayName: 'Config descriptor read',
      registrationRevision: 1,
      declaredRootHash: '5'.repeat(64),
      enabled: true,
    });
    const bootId = parseBootId(`boot_team-lifecycle-read-config-${filesystemRoots.length}`);
    const mountBinding = new WorkspaceMountBinding({
      registration,
      bootId,
      mountGeneration: 1,
      declaredRootHash: registration.declaredRootHash,
      observedAt: NOW_MS,
      health: 'read-only',
      allowedOperations: [],
    });
    const runtimeInstance = createRuntimeInstanceContext({
      deploymentId: 'deployment_team-lifecycle-read-config',
      bootId,
      claudeRoot: { kind: 'claude', reference: claudeRoot },
      appDataRoot: { kind: 'app-data', reference: path.join(claudeRoot, 'app-data') },
      workspaceRoots: [{ kind: 'workspace', reference: path.join(claudeRoot, 'workspace') }],
      tempRoot: { kind: 'temp', reference: path.join(claudeRoot, 'temp') },
      logsRoot: { kind: 'logs', reference: path.join(claudeRoot, 'logs') },
    });
    const readAuthority = createTeamLifecycleReadAuthority({
      actorId: 'actor_team-lifecycle-read-config',
      authorizedScope: 'scope_team-lifecycle.read',
      mountBinding,
      runtimeInstance,
    });
    const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
      authority: readAuthority,
      mountBinding,
      runtimeInstance,
      teamIdentities: {
        listTeamIdentities: () => Promise.resolve([team]),
        getTeamIdentity: () => Promise.resolve(team),
      },
      nowMs: options.nowMs ?? (() => NOW_MS),
    });
    const composition = createTeamLifecycleReadComposition({
      authority: readAuthority,
      ...readPorts,
      nowMs: options.nowMs ?? (() => NOW_MS),
    });
    return {
      claudeRoot,
      teamRoot,
      configPath,
      composition,
      context: (signal = new AbortController().signal) => boundaryContext(readAuthority, signal),
    };
  }

  it('accepts the matching canonical identity and directory fingerprint', async () => {
    const harness = await createFilesystemHarness();
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({
      kind: 'success',
      items: [{ workspaceId: WORKSPACE_ID, teamId: identity('a').teamId }],
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(harness.configPath, expect.anything());
  });

  it('rejects a copied replacement directory before configuration access', async () => {
    const harness = await createFilesystemHarness();
    const originalTeamRoot = `${harness.teamRoot}.original`;
    const copiedTeamRoot = `${harness.teamRoot}.copied`;
    await fs.promises.cp(harness.teamRoot, copiedTeamRoot, { recursive: true });
    await fs.promises.rename(harness.teamRoot, originalTeamRoot);
    await fs.promises.rename(copiedTeamRoot, harness.teamRoot);
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
    expect(lstatSpy).not.toHaveBeenCalledWith(harness.configPath);
    expect(openSpy).not.toHaveBeenCalledWith(harness.configPath, expect.anything());
  });

  it('rejects a canonical identity TeamId mismatch before reading configuration', async () => {
    const harness = await createFilesystemHarness({
      identityFileTeamId: identity('b').teamId,
    });
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
    expect(openSpy).not.toHaveBeenCalledWith(harness.configPath, expect.anything());
  });

  it('surfaces typed unavailability instead of inventing inactive runtime evidence', async () => {
    const harness = await createFilesystemHarness();
    const team = identity('a');

    await expect(
      harness.composition.teamLifecycle.getRuntimeStateProjection(
        {
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          workspaceId: WORKSPACE_ID,
          teamId: team.teamId,
          expectedRevision: null,
        },
        harness.context()
      )
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
    await expect(
      harness.composition.teamLifecycle.listAliveTeamProjections(
        {
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          cursor: null,
          expectedRevision: null,
        },
        harness.context()
      )
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked config before descriptor I/O',
    async () => {
      const outsideRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'team-lifecycle-read-config-outside-')
      );
      filesystemRoots.push(outsideRoot);
      const target = path.join(outsideRoot, 'config.json');
      await fs.promises.writeFile(target, JSON.stringify({ name: 'team-a' }));
      const harness = await createFilesystemHarness({ configSymlinkTarget: target });
      const openSpy = vi.spyOn(fs.promises, 'open');

      await expect(
        harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
      ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
      expect(openSpy).not.toHaveBeenCalledWith(
        harness.configPath,
        expect.anything(),
        expect.anything()
      );
    }
  );

  it('rejects a config larger than the 2 MiB descriptor bound', async () => {
    const harness = await createFilesystemHarness({
      configBytes: Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
    });
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
    expect(openSpy).not.toHaveBeenCalledWith(
      harness.configPath,
      expect.anything(),
      expect.anything()
    );
  });

  it('checks the deadline at the oversized-config early return', async () => {
    let nowMs = NOW_MS;
    const harness = await createFilesystemHarness({
      configBytes: Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
      nowMs: () => nowMs,
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target, options) => {
      const stat = await originalLstat(target, options);
      if (target !== harness.configPath) return stat;
      return new Proxy(stat, {
        get(value, property, receiver) {
          if (property === 'size') nowMs = NOW_MS + 10_000;
          return Reflect.get(value, property, receiver);
        },
      });
    });
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled', reason: 'deadline_exceeded' },
    });
    expect(openSpy).not.toHaveBeenCalledWith(harness.configPath, expect.anything());
  });

  it('rejects pathname replacement after the descriptor is opened', async () => {
    const harness = await createFilesystemHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (target === harness.configPath) {
        await fs.promises.rename(harness.configPath, `${harness.configPath}.replaced`);
        await fs.promises.writeFile(harness.configPath, JSON.stringify({ name: 'team-a' }));
      }
      return handle;
    });

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
  });

  it('rejects config growth after pathname validation', async () => {
    const harness = await createFilesystemHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (target === harness.configPath) {
        const writer = await originalOpen(harness.configPath, 'a');
        try {
          await writer.write(' ');
        } finally {
          await writer.close();
        }
      }
      return handle;
    });

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(listRequest(), harness.context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unavailable' } });
  });

  it('checks cancellation immediately after successful config filesystem I/O', async () => {
    const harness = await createFilesystemHarness();
    const controller = new AbortController();
    const originalRealpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (target, options) => {
      const value = await originalRealpath(target, options as BufferEncoding | undefined);
      if (target === harness.configPath) controller.abort();
      return value;
    });
    const openSpy = vi.spyOn(fs.promises, 'open');

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(
        listRequest(),
        harness.context(controller.signal)
      )
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'cancelled' } });
    expect(openSpy).not.toHaveBeenCalledWith(harness.configPath, expect.anything());
  });

  it('checks cancellation immediately after failed config filesystem I/O', async () => {
    const harness = await createFilesystemHarness();
    const controller = new AbortController();
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target, options) => {
      if (target === harness.configPath) {
        controller.abort();
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return originalLstat(target, options);
    });

    await expect(
      harness.composition.teamLifecycle.listTeamLifecycle(
        listRequest(),
        harness.context(controller.signal)
      )
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'cancelled' } });
  });
});
