import { describe, expect, it, vi } from 'vitest';
import {
  launchOpenCodeAggregatePrimaryLane,
  persistOpenCodeRuntimeAdapterLaunchResult,
  type PersistOpenCodeRuntimeAdapterLaunchResultPorts,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeAggregateLaunchPersistence';
import { answerOpenCodeRuntimeToolApproval } from '@main/services/team/provisioning/TeamProvisioningRuntimeToolApprovalAnswer';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { snapshotToMemberSpawnStatuses } from '@main/services/team/TeamLaunchStateEvaluator';
import type { TeamRuntimeLaunchInput, TeamRuntimeLaunchResult } from '@main/services/team/runtime';
import type {
  MemberSpawnStatusesSnapshotPorts,
  MemberSpawnStatusRun,
} from '@main/services/team/provisioning/TeamProvisioningMemberSpawnSnapshots';
import type { MemberSpawnStatusesSnapshot, PersistedTeamLaunchSnapshot } from '@shared/types';

const commit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock(
  '@main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence',
  async (original) => ({
    ...(await original<object>()),
    commitOpenCodeRuntimeBootstrapSessionEvidence: commit,
    hasCommittedOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(async () => true),
  })
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  commit.mockClear();
  const teamName = 'TEST-primary-status';
  const runId = 'TEST-run';
  const expectedMembers = ['team-lead', 'worker'].map((name) => ({
    name,
    providerId: 'opencode' as const,
    model: 'aisdk:TEST/model',
    cwd: '/TEST/project',
  }));
  const launchInput: TeamRuntimeLaunchInput = {
    runId,
    teamName,
    providerId: 'opencode',
    cwd: '/TEST/project',
    skipPermissions: false,
    expectedMembers,
    previousLaunchState: null,
  };
  const evidence = (ready: boolean): TeamRuntimeLaunchResult => ({
    runId,
    teamName,
    launchPhase: ready ? 'finished' : 'active',
    teamLaunchState: ready ? 'clean_success' : 'partial_pending',
    warnings: [],
    diagnostics: [],
    members: Object.fromEntries(
      expectedMembers.map(({ name }) => [
        name,
        {
          memberName: name,
          providerId: 'opencode',
          model: 'aisdk:TEST/model',
          launchState: ready ? 'confirmed_alive' : 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: ready,
          bootstrapConfirmed: ready,
          hardFailure: false,
          sessionId: 'TEST-session-' + name,
          diagnostics: [],
        },
      ])
    ),
  });
  const owner = {
    runId,
    providerId: 'opencode',
    launchInput,
    launchStopGeneration: 0,
    launchStopAllGeneration: 0,
    members: evidence(false).members,
  };
  const owners = new Map([[teamName, owner]]);
  let trackedRun = runId;
  let stopGeneration = 0;
  let generation = 0;
  let snapshot: PersistedTeamLaunchSnapshot | null = null;
  const statuses = () =>
    snapshot
      ? snapshotToMemberSpawnStatuses(snapshot)
      : Object.fromEntries(
          expectedMembers.map(({ name }) => [
            name,
            {
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: false,
              updatedAt: '2026-10-10T00:00:00.000Z',
            },
          ])
        );
  const reconcile = vi.fn(async () => evidence(true));
  const write = vi.fn(
    async (
      _team: string,
      next: PersistedTeamLaunchSnapshot,
      options: {
        isAuthorized?: () => boolean;
        runId: string;
      }
    ) => {
      expect(options.runId).toBe(runId);
      if (options.isAuthorized?.() === false) throw new Error('TEST-stale-write');
      snapshot = next;
      return next;
    }
  );
  const boundaryRead = async () => ({ snapshot, statuses: statuses() });
  const service = Object.create(TeamProvisioningService.prototype) as {
    getMemberSpawnStatuses: TeamProvisioningService['getMemberSpawnStatuses'];
    reconcilePersistedLaunchState(team: string): ReturnType<typeof boundaryRead>;
  };
  const ports = {
    getRun: () => undefined,
    cache: {
      snapshotCache: new Map(),
      inFlightByTeam: new Map(),
      getCacheGeneration: () => generation,
      getTrackedRunId: () => trackedRun,
      nowMs: () => Date.now(),
      liveCacheTtlMs: 0,
      persistedCacheTtlMs: 0,
    },
    persisted: {
      readTaskActivityRepairLaunchSnapshot: async () => null,
      repairStaleTaskActivityIntervalsOnce: () => undefined,
      reconcilePersistedLaunchState: (team: string) => service.reconcilePersistedLaunchState(team),
      attachLiveRuntimeMetadataToStatuses: async (_team: string, current: unknown) => current,
      getOpenCodeSecondaryBootstrapPendingMemberNames: () => new Set(),
      resumeActiveTaskActivityForMembers: () => undefined,
      readLaunchFreshness: async () => null,
    },
    live: {
      getPersistedLaunchMemberNames: (current: PersistedTeamLaunchSnapshot) =>
        current.expectedMembers,
      deriveTeamLaunchAggregateState: () => snapshot?.teamLaunchState ?? 'partial_pending',
    },
    nowIso: () => new Date().toISOString(),
  } as unknown as MemberSpawnStatusesSnapshotPorts<MemberSpawnStatusRun>;
  Object.assign(service, {
    runtimeAdapterRunByTeam: owners,
    stopAllTeamsGeneration: 0,
    getStopTeamGeneration: () => stopGeneration,
    runTracking: { getTrackedRunId: () => trackedRun },
    getOpenCodeRuntimeAdapter: () => ({ reconcile }),
    createMemberSpawnStatusesSnapshotPorts: () => ports,
    launchStateCompatibilityBoundary: { reconcilePersistedLaunchState: boundaryRead },
    createOpenCodeLaunchPersistencePorts: () => ({
      createOpenCodeRuntimeBootstrapEvidencePorts: () => ({ teamsBasePath: '/TEST/teams' }),
      nowIso: () => new Date().toISOString(),
      writeLaunchStateSnapshot: write,
    }),
    runtimeSnapshotCacheBoundary: {
      invalidateRuntimeSnapshotCaches: () => {
        generation++;
      },
    },
  });
  const persistencePorts: PersistOpenCodeRuntimeAdapterLaunchResultPorts = {
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      ({ teamsBasePath: '/TEST/teams' }) as ReturnType<
        PersistOpenCodeRuntimeAdapterLaunchResultPorts['createOpenCodeRuntimeBootstrapEvidencePorts']
      >,
    nowIso: () => new Date().toISOString(),
    writeLaunchStateSnapshot: write,
  };
  const publishAggregate = async (mixed = false) => {
    owners.clear();
    const launch = vi.fn(async (_input: TeamRuntimeLaunchInput) => evidence(false));
    const secondary = {
      laneId: 'secondary',
      runId: 'TEST-secondary',
      state: 'finished',
      member: { name: 'secondary' },
      result: {
        ...evidence(false),
        runId: 'TEST-secondary',
        members: {
          secondary: { ...evidence(false).members.worker!, memberName: 'secondary' },
        },
      },
    };
    await launchOpenCodeAggregatePrimaryLane(
      {
        run: {
          runId,
          teamName,
          request: { cwd: launchInput.cwd, model: 'aisdk:TEST/model', members: expectedMembers },
          effectiveMembers: expectedMembers,
          memberSpawnStatuses: new Map(),
          mixedSecondaryLanes: mixed ? [secondary] : [],
        } as unknown as Parameters<typeof launchOpenCodeAggregatePrimaryLane>[0]['run'],
        adapter: { launch } as unknown as TeamLaunchRuntimeAdapter,
        prompt: 'TEST bootstrap',
        previousLaunchState: null,
        launchStopGeneration: stopGeneration,
        launchStopAllGeneration: 0,
      },
      {
        getTeamsBasePath: () => '/TEST/teams',
        getOpenCodeRuntimeLaunchCwd: () => launchInput.cwd,
        migrateLegacyOpenCodeRuntimeState: async () => ({}),
        upsertOpenCodeRuntimeLaneIndexEntry: async () => undefined,
        setOpenCodeRuntimeActiveRunManifest: async () => undefined,
        clearOpenCodeRuntimeLaneStorage: async () => true,
        persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
          persistOpenCodeRuntimeAdapterLaunchResult(result, input, persistencePorts),
        syncOpenCodeRuntimeToolApprovals: () => undefined,
        setRuntimeAdapterRunByTeam: (_team, next) => {
          owners.set(teamName, next as typeof owner);
        },
      }
    );
    write.mockClear();
    commit.mockClear();
    return { launch, secondary };
  };
  return {
    service,
    publishAggregate,
    launchInput,
    persistencePorts,
    owner,
    owners,
    reconcile,
    write,
    evidence,
    stop: () => {
      stopGeneration++;
    },
    replace: () => {
      owners.set(teamName, { ...owner, runId: 'TEST-replacement' });
      trackedRun = 'TEST-replacement';
    },
    teamName,
  };
}

describe('primary OpenCode writable status refresh', () => {
  it('composes real aggregate publication with the real public getter for both members', async () => {
    const f = fixture();
    const { launch } = await f.publishAggregate();
    const published = f.owners.get(f.teamName)!;
    const result = await f.service.getMemberSpawnStatuses(f.teamName);
    expect(result.runId).toBe('TEST-run');
    for (const name of ['team-lead', 'worker']) {
      expect(result.statuses[name]).toMatchObject({ bootstrapConfirmed: true, runtimeAlive: true });
      expect(published.members[name]?.sessionId).toBe('TEST-session-' + name);
      expect(published.members[name]?.bootstrapConfirmed).toBe(true);
    }
    expect(published.launchInput).toBe(launch.mock.calls[0]![0]);
    expect(published.launchStopGeneration).toBe(0);
    expect(published.launchStopAllGeneration).toBe(0);
    expect(Object.getOwnPropertyDescriptor(published, 'members')?.set).toBeTypeOf('function');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('leaves mixed aggregate snapshots outside primary-only refresh and preserves their overlay', async () => {
    const f = fixture();
    const { secondary } = await f.publishAggregate(true);
    const published = f.owners.get(f.teamName)!;
    expect(published.launchInput).toBeUndefined();
    await f.service.getMemberSpawnStatuses(f.teamName);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    published.members = f.evidence(true).members;
    expect(published.members.worker?.bootstrapConfirmed).toBe(true);
    expect(published.members.secondary).toBe(secondary.result.members.secondary);
    secondary.result.members.secondary.bootstrapConfirmed = true;
    expect(published.members.secondary?.bootstrapConfirmed).toBe(true);
  });
  it('preserves original authority on permission replacement and fences an older status read', async () => {
    const f = fixture();
    await f.publishAggregate();
    const published = f.owners.get(f.teamName)!;
    const delayed = deferred<TeamRuntimeLaunchResult>();
    f.reconcile.mockImplementation(() => delayed.promise);
    const reading = f.service.getMemberSpawnStatuses(f.teamName);
    await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1));
    const permissionInput = {
      runId: 'TEST-run',
      teamName: f.teamName,
      laneId: 'primary',
      memberName: 'worker',
      requestId: 'TEST-request',
      cwd: '/TEST/project',
      allow: true,
    };
    await answerOpenCodeRuntimeToolApproval(
      {
        providerId: 'opencode',
        teamName: f.teamName,
        runId: 'TEST-run',
        laneId: 'primary',
        memberName: 'worker',
        providerRequestId: 'TEST-request',
        cwd: '/TEST/project',
        expectedMembers: f.launchInput.expectedMembers,
        approval: { teamName: f.teamName, runId: 'TEST-run' },
      } as unknown as Parameters<typeof answerOpenCodeRuntimeToolApproval>[0],
      true,
      {
        getOpenCodeRuntimeAdapter: () =>
          ({
            answerRuntimePermission: async () => f.evidence(false),
          }) as unknown as TeamLaunchRuntimeAdapter,
        readLaunchState: async () => null,
        buildOpenCodeRuntimePermissionAnswerInput: () => permissionInput,
        buildOpenCodeRuntimePermissionLaunchInput: () => published.launchInput,
        persistOpenCodeRuntimeAdapterLaunchResult: (
          result: TeamRuntimeLaunchResult,
          input: TeamRuntimeLaunchInput
        ) => persistOpenCodeRuntimeAdapterLaunchResult(result, input, f.persistencePorts),
        getRuntimeAdapterRunByTeam: () => f.owners.get(f.teamName),
        setRuntimeAdapterRunByTeam: (_team: string, next: { runId: string }) =>
          f.owners.set(f.teamName, next as typeof published),
        getTrackedRunId: () => 'TEST-run',
        getRun: () => undefined,
        setAliveRunId: () => undefined,
        syncOpenCodeRuntimeToolApprovals: () => undefined,
        emitTeamChange: () => undefined,
      } as unknown as Parameters<typeof answerOpenCodeRuntimeToolApproval>[2]
    );
    const replacement = f.owners.get(f.teamName)!;
    expect(replacement).not.toBe(published);
    expect(replacement.launchInput).toBe(published.launchInput);
    expect(replacement.launchStopGeneration).toBe(published.launchStopGeneration);
    expect(replacement.launchStopAllGeneration).toBe(published.launchStopAllGeneration);
    delayed.resolve(f.evidence(true));
    const result = await reading;
    expect(result.statuses.worker?.bootstrapConfirmed).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('refreshes both original members through the real public getter without another launch', async () => {
    const f = fixture();
    const result: MemberSpawnStatusesSnapshot = await f.service.getMemberSpawnStatuses(f.teamName);
    expect(result.runId).toBe('TEST-run');
    for (const name of ['team-lead', 'worker']) {
      expect(result.statuses[name]).toMatchObject({ bootstrapConfirmed: true, runtimeAlive: true });
      expect(f.owner.members[name]?.sessionId).toBe('TEST-session-' + name);
    }
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: 'TEST-run',
        laneId: 'primary',
        reason: 'launch_progress',
        expectedMembers: f.owner.launchInput.expectedMembers,
      })
    );
    expect(commit).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each(['stop', 'replace'] as const)(
    'ignores a reconcile that settles after %s before any session write',
    async (action) => {
      const f = fixture();
      const delayed = deferred<TeamRuntimeLaunchResult>();
      f.reconcile.mockImplementation(() => delayed.promise);
      const reading = f.service.getMemberSpawnStatuses(f.teamName);
      await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1));
      f[action]();
      delayed.resolve(f.evidence(true));
      await reading;
      expect(commit).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.owner.members.worker?.bootstrapConfirmed).toBe(false);
    }
  );
  it.each([false, true])(
    'resolves a persistent pending/failure read once (hardFailure=%s)',
    async (hardFailure) => {
      const f = fixture();
      const pending = f.evidence(false);
      for (const member of Object.values(pending.members)) {
        member.hardFailure = hardFailure;
        if (hardFailure) member.launchState = 'failed_to_start';
      }
      if (hardFailure) pending.teamLaunchState = 'partial_failure';
      let calls = 0;
      f.reconcile.mockImplementation(async () => {
        if (++calls > 3) throw new Error('TEST-bounded-loop-detector');
        return pending;
      });
      const result = await f.service.getMemberSpawnStatuses(f.teamName);
      expect(result.runId).toBe('TEST-run');
      expect(calls).toBe(1);
      expect(f.write).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(result.statuses.worker?.bootstrapConfirmed).toBe(false);
    }
  );

  it('does not refresh an old owner when stop already began before the read', async () => {
    const f = fixture();
    f.stop();
    await f.service.getMemberSpawnStatuses(f.teamName);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('retains pending evidence on failed reads and changed session identity', async () => {
    const f = fixture();
    f.reconcile.mockRejectedValueOnce(new Error('TEST-transport'));
    expect(
      (await f.service.getMemberSpawnStatuses(f.teamName)).statuses.worker?.bootstrapConfirmed
    ).toBe(false);
    const wrong = f.evidence(true);
    wrong.members.worker!.sessionId = 'TEST-other-session';
    f.reconcile.mockResolvedValueOnce(wrong);
    expect(
      (await f.service.getMemberSpawnStatuses(f.teamName)).statuses.worker?.bootstrapConfirmed
    ).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
});
