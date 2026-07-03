import {
  buildMemberSpawnStatusesSnapshotForRun,
  confirmMemberSpawnStatusFromTranscriptForRun,
  getMemberSpawnStatusesSnapshot,
  maybeAuditMemberSpawnStatusesForRun,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusAuditRun,
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusRun,
  setMemberSpawnStatusForRun,
  shouldCacheMemberSpawnStatusesSnapshot,
} from '@main/services/team/provisioning/TeamProvisioningMemberSpawnSnapshots';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSnapshot,
  TeamProvisioningProgress,
} from '@shared/types';

const baseStatus = (patch: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'waiting',
  launchState: 'runtime_pending_bootstrap',
  agentToolAccepted: true,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

function makeRun(patch: Partial<MemberSpawnStatusRun> = {}): MemberSpawnStatusRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: { state: 'assembling', message: 'Launching' } as TeamProvisioningProgress,
    onProgress: vi.fn(),
    expectedMembers: ['alice'],
    detectedSessionId: 'session-1',
    isLaunch: true,
    provisioningComplete: false,
    memberSpawnStatuses: new Map([['alice', baseStatus()]]),
    pendingMemberRestarts: new Map(),
    ...patch,
  };
}

function makeAuditRun(patch: Partial<MemberSpawnStatusAuditRun> = {}): MemberSpawnStatusAuditRun {
  return {
    ...makeRun(),
    lastMemberSpawnAuditAt: 0,
    ...patch,
  };
}

function makeMutationPorts(): MemberSpawnStatusMutationPorts<MemberSpawnStatusRun> {
  return {
    nowIso: () => '2026-01-01T00:00:10.000Z',
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    updateLaunchDiagnostics: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    isCurrentTrackedRun: () => true,
    emitMemberSpawnChange: vi.fn(),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
  };
}

function makeAuditPorts(
  patch: Partial<MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun>> = {}
): MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun> {
  const ports: MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun> = {
    nowMs: () => 1_000,
    minAuditIntervalMs: 500,
    auditMemberSpawnStatuses: vi.fn(async () => undefined),
    findBootstrapTranscriptFailureReason: vi.fn(async () => null),
    findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
    findBootstrapTranscriptOutcome: vi.fn(async () => null),
    setMemberSpawnStatus: vi.fn((run, memberName, status, error) => {
      run.memberSpawnStatuses.set(memberName, {
        ...baseStatus({
          status,
          error,
          hardFailure: status === 'error',
          launchState: status === 'error' ? 'failed_to_start' : 'runtime_pending_bootstrap',
        }),
        updatedAt: '2026-01-01T00:00:10.000Z',
      });
    }),
    confirmMemberSpawnStatusFromTranscript: vi.fn((run, memberName, observedAt, source) => {
      run.memberSpawnStatuses.set(memberName, {
        ...baseStatus({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: true,
          lastHeartbeatAt: observedAt,
          livenessKind: source === 'runtime-proof' ? 'confirmed_bootstrap' : undefined,
        }),
      });
    }),
    isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => false),
    ...patch,
  };
  return ports;
}

function makeLaunchSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: '2026-01-01T00:00:10.000Z',
    leadSessionId: 'session-1',
    launchPhase: 'active',
    expectedMembers: ['alice'],
    members: {},
    summary: {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      skippedCount: 0,
      runtimeAlivePendingCount: 0,
      shellOnlyPendingCount: 0,
      runtimeProcessPendingCount: 0,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 0,
    },
    teamLaunchState: 'clean_success',
  };
}

type TestSnapshotCache = Map<
  string,
  {
    expiresAtMs: number;
    generation: number;
    runId: string | null;
    snapshot: MemberSpawnStatusesSnapshot;
  }
>;

type TestInFlightByTeam = Map<
  string,
  {
    generationAtStart: number;
    runIdAtStart: string;
    promise: Promise<MemberSpawnStatusesSnapshot>;
  }
>;

function makeSnapshotPorts(params?: {
  run?: MemberSpawnStatusRun;
  generation?: number;
  trackedRunId?: string | null;
  nowMs?: number;
}): {
  ports: MemberSpawnStatusesSnapshotPorts<MemberSpawnStatusRun>;
  snapshotCache: TestSnapshotCache;
  inFlightByTeam: TestInFlightByTeam;
  liveBuilds: { count: number };
} {
  const snapshotCache: TestSnapshotCache = new Map();
  const inFlightByTeam: TestInFlightByTeam = new Map();
  const liveBuilds = { count: 0 };
  const run = params?.run ?? makeRun();
  const snapshot = makeLaunchSnapshot();
  const ports: MemberSpawnStatusesSnapshotPorts<MemberSpawnStatusRun> = {
    getRun: (runId) => (runId === run.runId ? run : undefined),
    cache: {
      snapshotCache,
      inFlightByTeam,
      getCacheGeneration: () => params?.generation ?? 1,
      getTrackedRunId: () => params?.trackedRunId ?? run.runId,
      nowMs: () => params?.nowMs ?? 1_000,
      liveCacheTtlMs: 500,
      persistedCacheTtlMs: 5_000,
    },
    persisted: {
      readTaskActivityRepairLaunchSnapshot: vi.fn(async () => null),
      repairStaleTaskActivityIntervalsOnce: vi.fn(),
      reconcilePersistedLaunchState: vi.fn(async () => ({
        snapshot,
        statuses: { alice: baseStatus({ runtimeAlive: true }) },
      })),
      attachLiveRuntimeMetadataToStatuses: vi.fn(async (_teamName, statuses) => statuses),
      getOpenCodeSecondaryBootstrapPendingMemberNames: vi.fn(() => new Set<string>()),
      resumeActiveTaskActivityForMembers: vi.fn(),
    },
    live: {
      refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
      maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
      persistLaunchStateSnapshot: vi.fn(async () => undefined),
      readLaunchState: vi.fn(async () => null),
      syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
      buildLiveLaunchSnapshotForRun: vi.fn(() => {
        liveBuilds.count += 1;
        return snapshot;
      }),
      buildSnapshotFromRuntimeMemberStatuses: vi.fn(() => snapshot),
      buildRuntimeSpawnStatusRecord: vi.fn(() => ({ alice: baseStatus() })),
      getMembersMeta: vi.fn(async () => []),
      filterRemovedMembersFromLaunchSnapshot: vi.fn((targetSnapshot) => targetSnapshot),
      snapshotToMemberSpawnStatuses: vi.fn(() => ({
        alice: baseStatus({ status: 'online', launchState: 'confirmed_alive' }),
      })),
      getPersistedLaunchMemberNames: vi.fn(() => ['alice']),
      deriveTeamLaunchAggregateState: vi.fn(() => 'clean_success' as const),
    },
    nowIso: () => '2026-01-01T00:00:10.000Z',
  };
  return { ports, snapshotCache, inFlightByTeam, liveBuilds };
}

describe('TeamProvisioningMemberSpawnSnapshots', () => {
  it('updates transcript confirmations through explicit mutation ports', () => {
    const run = makeRun();
    const ports = makeMutationPorts();

    confirmMemberSpawnStatusFromTranscriptForRun(
      {
        run,
        memberName: 'alice',
        observedAt: '2026-01-01T00:00:05.000Z',
      },
      ports
    );

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      bootstrapConfirmed: true,
      lastHeartbeatAt: '2026-01-01T00:00:05.000Z',
      launchState: 'confirmed_alive',
    });
    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      run,
      'alice',
      'bootstrap confirmed via transcript'
    );
    expect(ports.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'alice');
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
  });

  it('routes status changes through diagnostics and cache invalidation ports', () => {
    const run = makeRun({ memberSpawnStatuses: new Map() });
    const ports = makeMutationPorts();

    setMemberSpawnStatusForRun(
      {
        run,
        memberName: 'alice',
        status: 'waiting',
      },
      ports
    );

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'waiting',
      agentToolAccepted: true,
      firstSpawnAcceptedAt: '2026-01-01T00:00:10.000Z',
    });
    expect(ports.updateLaunchDiagnostics).toHaveBeenCalledWith(run);
    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      run,
      'alice',
      'spawn accepted, waiting for teammate check-in'
    );
  });

  it('keeps member spawn status snapshot cache decisions focused on active launches', () => {
    expect(shouldCacheMemberSpawnStatusesSnapshot(makeRun())).toBe(true);
    expect(shouldCacheMemberSpawnStatusesSnapshot(makeRun({ provisioningComplete: true }))).toBe(
      false
    );
    expect(shouldCacheMemberSpawnStatusesSnapshot(makeRun({ isLaunch: false }))).toBe(false);
  });

  it('returns cloned cached live snapshots without rebuilding them', async () => {
    const { ports, snapshotCache, liveBuilds } = makeSnapshotPorts();
    const cachedSnapshot: MemberSpawnStatusesSnapshot = {
      statuses: {
        alice: baseStatus({ pendingPermissionRequestIds: ['perm-1'] }),
      },
      runId: 'run-1',
      expectedMembers: ['alice'],
      source: 'live',
    };
    snapshotCache.set('team-a', {
      expiresAtMs: 2_000,
      generation: 1,
      runId: 'run-1',
      snapshot: cachedSnapshot,
    });

    const result = await getMemberSpawnStatusesSnapshot('team-a', ports);
    result.statuses.alice!.pendingPermissionRequestIds!.push('perm-2');
    result.expectedMembers!.push('bob');

    expect(liveBuilds.count).toBe(0);
    expect(cachedSnapshot.statuses.alice?.pendingPermissionRequestIds).toEqual(['perm-1']);
    expect(cachedSnapshot.expectedMembers).toEqual(['alice']);
  });

  it('builds and caches active launch snapshots when generation stays current', async () => {
    const { ports, snapshotCache, liveBuilds } = makeSnapshotPorts();

    const result = await buildMemberSpawnStatusesSnapshotForRun(makeRun(), ports, 1);

    expect(liveBuilds.count).toBe(1);
    expect(result).toMatchObject({
      runId: 'run-1',
      source: 'live',
      expectedMembers: ['alice'],
      teamLaunchState: 'clean_success',
    });
    expect(snapshotCache.get('team-a')).toMatchObject({
      generation: 1,
      runId: 'run-1',
    });
  });

  it('reconciles bootstrap transcript failures before auditing pending members', async () => {
    const run = makeAuditRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          baseStatus({
            firstSpawnAcceptedAt: '2026-01-01T00:00:05.000Z',
          }),
        ],
      ]),
    });
    const ports = makeAuditPorts({
      findBootstrapTranscriptFailureReason: vi.fn(async () => 'bootstrap failed'),
    });

    await maybeAuditMemberSpawnStatusesForRun(run, ports);

    expect(ports.findBootstrapTranscriptFailureReason).toHaveBeenCalledWith(
      'team-a',
      'alice',
      Date.parse('2026-01-01T00:00:05.000Z')
    );
    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'alice',
      'error',
      'bootstrap failed'
    );
    expect(ports.auditMemberSpawnStatuses).not.toHaveBeenCalled();
  });

  it('clears retryable bootstrap failures when runtime proof is found', async () => {
    const run = makeAuditRun({
      memberSpawnStatuses: new Map([
        [
          'alice',
          baseStatus({
            status: 'error',
            launchState: 'failed_to_start',
            hardFailure: true,
            hardFailureReason:
              'CLI process exited (code 1) - team provisioned but not alive',
            firstSpawnAcceptedAt: '2026-01-01T00:00:05.000Z',
          }),
        ],
      ]),
    });
    const ports = makeAuditPorts({
      findBootstrapRuntimeProofObservedAt: vi.fn(async () => '2026-01-01T00:00:09.000Z'),
    });

    await maybeAuditMemberSpawnStatusesForRun(run, ports, { force: true });

    expect(ports.confirmMemberSpawnStatusFromTranscript).toHaveBeenCalledWith(
      run,
      'alice',
      '2026-01-01T00:00:09.000Z',
      'runtime-proof'
    );
    expect(ports.auditMemberSpawnStatuses).not.toHaveBeenCalled();
  });
});
