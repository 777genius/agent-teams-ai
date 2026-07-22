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
    persistLaunchStateSnapshot: vi.fn(() => Promise.resolve(undefined)),
    reportBackgroundPersistenceError: vi.fn(),
  };
}

function makeAuditPorts(
  patch: Partial<MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun>> = {}
): MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun> {
  const ports: MemberSpawnStatusAuditPorts<MemberSpawnStatusAuditRun> = {
    nowMs: () => 1_000,
    minAuditIntervalMs: 500,
    auditMemberSpawnStatuses: vi.fn(() => Promise.resolve(undefined)),
    findBootstrapTranscriptFailureReason: vi.fn(() => Promise.resolve(null)),
    findBootstrapRuntimeProofObservedAt: vi.fn(() => Promise.resolve(null)),
    findBootstrapTranscriptOutcome: vi.fn(() => Promise.resolve(null)),
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

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
      readTaskActivityRepairLaunchSnapshot: vi.fn(() => Promise.resolve(null)),
      repairStaleTaskActivityIntervalsOnce: vi.fn(),
      reconcilePersistedLaunchState: vi.fn(() =>
        Promise.resolve({
          snapshot,
          statuses: { alice: baseStatus({ runtimeAlive: true }) },
        })
      ),
      attachLiveRuntimeMetadataToStatuses: vi.fn((_teamName, statuses) =>
        Promise.resolve(statuses)
      ),
      getOpenCodeSecondaryBootstrapPendingMemberNames: vi.fn(() => new Set<string>()),
      resumeActiveTaskActivityForMembers: vi.fn(),
    },
    live: {
      refreshMemberSpawnStatusesFromLeadInbox: vi.fn(() => Promise.resolve(undefined)),
      maybeAuditMemberSpawnStatuses: vi.fn(() => Promise.resolve(undefined)),
      persistLaunchStateSnapshot: vi.fn(() => Promise.resolve(undefined)),
      readLaunchState: vi.fn(() => Promise.resolve(null)),
      syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
      buildLiveLaunchSnapshotForRun: vi.fn(() => {
        liveBuilds.count += 1;
        return snapshot;
      }),
      buildSnapshotFromRuntimeMemberStatuses: vi.fn(() => snapshot),
      buildRuntimeSpawnStatusRecord: vi.fn(() => ({ alice: baseStatus() })),
      getMembersMeta: vi.fn(() => Promise.resolve([])),
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
    result.statuses.alice.pendingPermissionRequestIds!.push('perm-2');
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

  it('does not let a read stalled in refresh persist or replace a newer-generation snapshot', async () => {
    const run = makeRun();
    const refreshStaleGeneration = createDeferred();
    let generation = 1;
    let persistedRunId: string | null = null;
    const { ports, snapshotCache } = makeSnapshotPorts({ run });
    ports.cache.getCacheGeneration = () => generation;
    ports.live.refreshMemberSpawnStatusesFromLeadInbox = vi
      .fn()
      .mockImplementationOnce(() => refreshStaleGeneration.promise)
      .mockResolvedValue(undefined);
    ports.live.persistLaunchStateSnapshot = vi.fn((run) => {
      persistedRunId = run.runId;
      return Promise.resolve(undefined);
    });

    const staleRead = getMemberSpawnStatusesSnapshot('team-a', ports);
    expect(ports.live.refreshMemberSpawnStatusesFromLeadInbox).toHaveBeenCalledWith(run);

    generation = 2;
    const currentSnapshot = await getMemberSpawnStatusesSnapshot('team-a', ports);
    const cachedCurrentSnapshot = snapshotCache.get('team-a');

    refreshStaleGeneration.resolve();
    const retriedSnapshot = await staleRead;

    expect(currentSnapshot.runId).toBe(run.runId);
    expect(retriedSnapshot.runId).toBe(run.runId);
    expect(persistedRunId).toBe(run.runId);
    expect(ports.live.maybeAuditMemberSpawnStatuses).toHaveBeenCalledTimes(1);
    expect(ports.live.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(run);
    expect(ports.live.persistLaunchStateSnapshot).toHaveBeenCalledTimes(1);
    expect(ports.live.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
    expect(snapshotCache.get('team-a')).toBe(cachedCurrentSnapshot);
    expect(cachedCurrentSnapshot).toMatchObject({ generation: 2, runId: run.runId });
  });

  it('does not let a read stalled in audit overwrite newer launch persistence', async () => {
    const oldRun = makeRun();
    const newRun = makeRun({ runId: 'run-2', detectedSessionId: 'session-2' });
    const auditOldRun = createDeferred();
    const auditOldRunStarted = createDeferred();
    let trackedRunId = oldRun.runId;
    const persistedRunIds: string[] = [];
    const { ports, snapshotCache } = makeSnapshotPorts({ run: oldRun });
    ports.getRun = (runId) => {
      if (runId === oldRun.runId) return oldRun;
      if (runId === newRun.runId) return newRun;
      return undefined;
    };
    ports.cache.getTrackedRunId = () => trackedRunId;
    ports.live.maybeAuditMemberSpawnStatuses = vi.fn((run) => {
      if (run.runId !== oldRun.runId) return Promise.resolve();
      auditOldRunStarted.resolve();
      return auditOldRun.promise;
    });
    ports.live.persistLaunchStateSnapshot = vi.fn((run) => {
      persistedRunIds.push(run.runId);
      return Promise.resolve(undefined);
    });

    const staleRead = getMemberSpawnStatusesSnapshot('team-a', ports);
    await auditOldRunStarted.promise;
    expect(ports.live.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(oldRun);

    trackedRunId = newRun.runId;
    const currentSnapshot = await getMemberSpawnStatusesSnapshot('team-a', ports);
    const cachedCurrentSnapshot = snapshotCache.get('team-a');

    auditOldRun.resolve();
    const retriedSnapshot = await staleRead;

    expect(currentSnapshot.runId).toBe(newRun.runId);
    expect(retriedSnapshot.runId).toBe(newRun.runId);
    expect(persistedRunIds).toEqual([newRun.runId]);
    expect(snapshotCache.get('team-a')).toBe(cachedCurrentSnapshot);
    expect(cachedCurrentSnapshot).toMatchObject({ generation: 1, runId: newRun.runId });
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
      findBootstrapTranscriptFailureReason: vi.fn(() => Promise.resolve('bootstrap failed')),
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
            hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
            firstSpawnAcceptedAt: '2026-01-01T00:00:05.000Z',
          }),
        ],
      ]),
    });
    const ports = makeAuditPorts({
      findBootstrapRuntimeProofObservedAt: vi.fn(() => Promise.resolve('2026-01-01T00:00:09.000Z')),
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
