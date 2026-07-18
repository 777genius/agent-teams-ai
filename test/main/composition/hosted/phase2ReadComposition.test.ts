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
  createPhase2ReadAuthority,
  createPhase2ReadComposition,
  createPhase2ReadHost,
  createUnavailablePhase2ReadHost,
  type Phase2ReadAuthority,
} from '@main/composition/hosted/phase2ReadComposition';
import {
  createQueryContext,
  parseBootId,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const NOW_MS = Date.parse('2026-07-18T10:00:00.000Z');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const FOREIGN_WORKSPACE_ID = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);

interface AuthorityOverrides {
  readonly actorId?: string;
  readonly authorizedScope?: string;
  readonly workspaceId?: typeof WORKSPACE_ID;
  readonly workspaceGeneration?: number;
  readonly deploymentId?: string;
  readonly bootId?: string;
}

function authority(overrides: AuthorityOverrides = {}): Phase2ReadAuthority {
  const workspaceId = overrides.workspaceId ?? WORKSPACE_ID;
  const workspaceGeneration = overrides.workspaceGeneration ?? 1;
  const bootId = overrides.bootId ?? 'boot_phase2-composition';
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-${workspaceId}`,
    workspaceId,
    displayName: 'Phase 2 composition test',
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
    deploymentId: overrides.deploymentId ?? 'deployment_phase2-composition',
    bootId,
    claudeRoot: { kind: 'claude', reference: 'runtime://claude' },
    appDataRoot: { kind: 'app-data', reference: 'runtime://app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: 'runtime://workspace' }],
    tempRoot: { kind: 'temp', reference: 'runtime://temp' },
    logsRoot: { kind: 'logs', reference: 'runtime://logs' },
  });
  return createPhase2ReadAuthority({
    actorId: overrides.actorId ?? 'actor_phase2-composition',
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

interface HarnessOptions {
  readonly authority?: Phase2ReadAuthority;
  readonly identities: readonly TeamIdentityRecord[] | null;
  readonly summaries?: readonly Record<string, unknown>[];
  readonly pageSize?: number;
  readonly beforeSummaryRead?: () => void;
}

function createHarness(options: HarnessOptions) {
  let identities = options.identities;
  let summaries =
    options.summaries ?? (identities ?? []).map((value) => ({ teamName: value.legacyKey }));
  let runtimeAlive = false;
  let contextSequence = 0;
  const readAuthority = options.authority ?? authority();
  const listTeamIdentities = vi.fn(() => Promise.resolve(identities ?? []));
  const gateway: TeamIdentityReadGateway | null = identities
    ? {
        listTeamIdentities,
        getTeamIdentity: vi.fn(() => Promise.resolve(null)),
      }
    : null;
  const getTeamData = vi.fn((teamName: string) =>
    Promise.resolve({ teamName, config: {}, warnings: [], isAlive: false })
  );
  const getRuntimeState = vi.fn((teamName: string) =>
    Promise.resolve({ teamName, isAlive: runtimeAlive })
  );
  const composition = createPhase2ReadComposition({
    authority: readAuthority,
    teamIdentities: gateway,
    legacyData: {
      listTeams: vi.fn(() => {
        options.beforeSummaryRead?.();
        return Promise.resolve(summaries);
      }),
      getTeamData,
    },
    legacyRuntime: {
      getRuntimeState,
      getAliveTeams: () => Promise.resolve(runtimeAlive ? ['team-a'] : []),
    },
    nowMs: () => NOW_MS,
    pageSize: options.pageSize,
  });
  const createContext = (): QueryContext =>
    createQueryContext({
      actorId: readAuthority.actorId,
      sessionId: 'session_phase2-composition',
      deploymentId: readAuthority.deploymentId,
      bootId: readAuthority.bootId,
      requestId: `request_phase2-composition-${++contextSequence}`,
      authorizedScope: readAuthority.authorizedScope,
      deadlineAtMs: NOW_MS + 10_000,
      signal: new AbortController().signal,
    });
  const host = createPhase2ReadHost(composition, createContext);
  return {
    authority: readAuthority,
    composition,
    createContext,
    getRuntimeState,
    getTeamData,
    host,
    listTeamIdentities,
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

describe('phase2ReadComposition semantic isolation', () => {
  it('keeps the fail-closed production host strict before reporting authority unavailable', async () => {
    const host = createUnavailablePhase2ReadHost();

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
