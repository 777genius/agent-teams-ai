import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeLaunchWiring,
  createTeamProvisioningOpenCodeLaunchWiringHostFromService,
  type OpenCodeAggregateProvisioningRun,
  type TeamProvisioningOpenCodeLaunchWiringHost,
  type TeamProvisioningOpenCodeLaunchWiringServiceHost,
} from '../TeamProvisioningOpenCodeLaunchWiring';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../../runtime';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest } from '@shared/types';

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getTeamsBasePath: () => '/safe-test/team-provisioning-opencode-launch-wiring-test',
  };
});

vi.mock('../../opencode/store/OpenCodeRuntimeManifestEvidenceReader', () => ({
  clearOpenCodeRuntimeLaneStorage: vi.fn(async () => undefined),
  migrateLegacyOpenCodeRuntimeState: vi.fn(async () => undefined),
  setOpenCodeRuntimeActiveRunManifest: vi.fn(async () => undefined),
  upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
}));

type OpenCodeMemberLanePlan = Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
type OpenCodeMember = OpenCodeMemberLanePlan['allMembers'][number];

function runtimeResult(overrides: Partial<TeamRuntimeLaunchResult> = {}): TeamRuntimeLaunchResult {
  return {
    runId: 'runtime-run',
    teamName: 'team-a',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      alice: {
        memberName: 'alice',
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        diagnostics: [],
      },
    },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

function request(members: TeamCreateRequest['members']): TeamCreateRequest {
  return {
    teamName: 'team-a',
    cwd: '/repo',
    providerId: 'opencode',
    color: 'blue',
    displayName: 'Team A',
    members,
  } as TeamCreateRequest;
}

function member(name: string): OpenCodeMember {
  return {
    name,
    role: 'Engineer',
    providerId: 'opencode',
  } as OpenCodeMember;
}

function lanePlan(input: {
  primaryMembers: OpenCodeMember[];
  sideMembers?: OpenCodeMember[];
}): OpenCodeMemberLanePlan {
  return {
    mode: 'pure_opencode_member_lanes',
    primaryMembers: input.primaryMembers,
    allMembers: [...input.primaryMembers, ...(input.sideMembers ?? [])],
    sideLanes: (input.sideMembers ?? []).map((sideMember) => ({
      laneId: `secondary:opencode:${sideMember.name}`,
      providerId: 'opencode',
      member: sideMember,
    })),
  };
}

function createHost(
  calls: string[],
  adapter: TeamLaunchRuntimeAdapter | null
): TeamProvisioningOpenCodeLaunchWiringHost<OpenCodeAggregateProvisioningRun> & {
  aliveRuns: Map<string, string>;
} {
  const aliveRuns = new Map<string, string>();
  const host: TeamProvisioningOpenCodeLaunchWiringHost<OpenCodeAggregateProvisioningRun> & {
    aliveRuns: Map<string, string>;
  } = {
    runtimeAdapterRunByTeam: new Map(),
    provisioningRunByTeam: new Map(),
    runtimeAdapterProgressByRunId: new Map(),
    cancelledRuntimeAdapterRunIds: new Set(),
    runs: new Map(),
    runtimeAdapterProgressState: {
      setRuntimeAdapterProgress: (progress, onProgress) => {
        calls.push(`progress:${progress.state}`);
        host.runtimeAdapterProgressByRunId.set(progress.runId, progress);
        onProgress?.(progress);
        return progress;
      },
    },
    runTracking: {
      setAliveRunId: (teamName, runId) => {
        calls.push('setAliveRun');
        aliveRuns.set(teamName, runId);
      },
      deleteAliveRunId: (teamName) => {
        calls.push('deleteAliveRun');
        aliveRuns.delete(teamName);
      },
    },
    getOpenCodeRuntimeAdapter: () => adapter,
    getStopAllTeamsGeneration: () => 0,
    stopOpenCodeRuntimeAdapterTeam: async () => {
      calls.push('stopPreviousRuntimeRun');
    },
    hasSecondaryRuntimeRuns: () => false,
    stopMixedSecondaryRuntimeLanes: async () => {
      calls.push('stopMixedSecondaryLanes');
    },
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => {
      calls.push('cancelPreviousPendingRun');
    },
    recordCancelledOpenCodeRuntimeAdapterLaunch: () => {
      calls.push('recordCancelledLaunch');
      return { runId: 'cancelled-run' };
    },
    resetTeamScopedTransientStateForNewRun: () => {
      calls.push('resetTransientState');
    },
    readLaunchState: async () => {
      calls.push('readLaunchState');
      return null;
    },
    clearPersistedLaunchState: async () => {
      calls.push('clearPersistedLaunchState');
    },
    invalidateRuntimeSnapshotCaches: () => {
      calls.push('invalidateCaches');
    },
    launchOpenCodeAggregatePrimaryLane: async () => {
      calls.push('launchPrimary');
      return runtimeResult();
    },
    launchSingleMixedSecondaryLane: async (_run, lane) => {
      calls.push(`launchSecondary:${lane.laneId}`);
      lane.state = 'finished';
      lane.result = runtimeResult();
    },
    summarizeOpenCodeAggregateLaunchState: () => {
      calls.push('summarizeAggregateState');
      return 'clean_success';
    },
    persistLaunchStateSnapshot: async (_run, launchPhase) => {
      calls.push(`persistSnapshot:${launchPhase}`);
      return null;
    },
    syncRunMemberSpawnStatusesFromSnapshot: () => {
      calls.push('syncSpawnStatuses');
    },
    deleteSecondaryRuntimeRun: (_teamName, laneId) => {
      calls.push(`deleteSecondary:${laneId}`);
    },
    getOpenCodeRuntimeLaunchCwd: () => {
      calls.push('getLaunchCwd');
      return '/repo/runtime';
    },
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: async () => {
      calls.push('clearPrimaryIfOwned');
    },
    persistOpenCodeRuntimeAdapterLaunchResult: async (result) => {
      calls.push('persistRuntimeResult');
      return { result };
    },
    syncOpenCodeRuntimeToolApprovals: () => {
      calls.push('syncApprovals');
    },
    emitTeamChange: (event) => {
      calls.push(`emit:${event.type}:${'detail' in event ? event.detail : ''}`);
    },
    aliveRuns,
  };
  return host;
}

describe('TeamProvisioningOpenCodeLaunchWiring', () => {
  it('builds launch wiring host from service-shaped dependencies', async () => {
    const calls: string[] = [];
    const adapter = {} as TeamLaunchRuntimeAdapter;
    const baseHost = createHost(calls, adapter);
    const serviceHost = {
      runtimeAdapterRunByTeam: baseHost.runtimeAdapterRunByTeam,
      provisioningRunByTeam: baseHost.provisioningRunByTeam,
      runtimeAdapterProgressByRunId: baseHost.runtimeAdapterProgressByRunId,
      cancelledRuntimeAdapterRunIds: baseHost.cancelledRuntimeAdapterRunIds,
      runs: baseHost.runs,
      runtimeAdapterProgressState: baseHost.runtimeAdapterProgressState,
      runTracking: baseHost.runTracking,
      stopAllTeamsGeneration: 42,
      appShellBoundary: {
        getOpenCodeRuntimeAdapter: baseHost.getOpenCodeRuntimeAdapter,
      },
      launchStateStore: {
        read: baseHost.readLaunchState,
      },
      cancellationBoundary: {
        isCancellableRuntimeAdapterProgress: baseHost.isCancellableRuntimeAdapterProgress,
        cancelRuntimeAdapterProvisioning: baseHost.cancelRuntimeAdapterProvisioning,
        recordCancelledOpenCodeRuntimeAdapterLaunch:
          baseHost.recordCancelledOpenCodeRuntimeAdapterLaunch,
        clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned:
          baseHost.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned,
      },
      prepareFacade: {
        getOpenCodeRuntimeLaunchCwd: baseHost.getOpenCodeRuntimeLaunchCwd,
      },
      toolApprovalFacade: {
        syncOpenCodeRuntimeToolApprovals: baseHost.syncOpenCodeRuntimeToolApprovals,
      },
      teamChangeEmitter: baseHost.emitTeamChange,
      stopOpenCodeRuntimeAdapterTeam: baseHost.stopOpenCodeRuntimeAdapterTeam,
      hasSecondaryRuntimeRuns: baseHost.hasSecondaryRuntimeRuns,
      stopMixedSecondaryRuntimeLanes: baseHost.stopMixedSecondaryRuntimeLanes,
      resetTeamScopedTransientStateForNewRun: baseHost.resetTeamScopedTransientStateForNewRun,
      clearPersistedLaunchState: baseHost.clearPersistedLaunchState,
      invalidateRuntimeSnapshotCaches: baseHost.invalidateRuntimeSnapshotCaches,
      launchOpenCodeAggregatePrimaryLane: baseHost.launchOpenCodeAggregatePrimaryLane,
      launchSingleMixedSecondaryLane: baseHost.launchSingleMixedSecondaryLane,
      summarizeOpenCodeAggregateLaunchState: baseHost.summarizeOpenCodeAggregateLaunchState,
      persistLaunchStateSnapshot: baseHost.persistLaunchStateSnapshot,
      syncRunMemberSpawnStatusesFromSnapshot: baseHost.syncRunMemberSpawnStatusesFromSnapshot,
      deleteSecondaryRuntimeRun: baseHost.deleteSecondaryRuntimeRun,
      persistOpenCodeRuntimeAdapterLaunchResult: baseHost.persistOpenCodeRuntimeAdapterLaunchResult,
    } satisfies TeamProvisioningOpenCodeLaunchWiringServiceHost<OpenCodeAggregateProvisioningRun>;
    const host = createTeamProvisioningOpenCodeLaunchWiringHostFromService(serviceHost);

    expect(host.runtimeAdapterRunByTeam).toBe(baseHost.runtimeAdapterRunByTeam);
    expect(host.getOpenCodeRuntimeAdapter()).toBe(adapter);
    expect(host.getStopAllTeamsGeneration()).toBe(42);
    await host.readLaunchState('team-a');
    host.getOpenCodeRuntimeLaunchCwd('/repo', []);
    await host.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned('team-a', 'runtime-run');
    host.syncOpenCodeRuntimeToolApprovals({
      teamName: 'team-a',
      runId: 'runtime-run',
      laneId: 'primary',
      cwd: '/repo',
      members: runtimeResult().members,
      expectedMembers: [],
    });
    host.emitTeamChange({ type: 'process', teamName: 'team-a', detail: 'ready' });

    expect(calls).toEqual([
      'readLaunchState',
      'getLaunchCwd',
      'clearPrimaryIfOwned',
      'syncApprovals',
      'emit:process:ready',
    ]);
  });

  it('throws the same missing OpenCode adapter error before launch side effects', async () => {
    const calls: string[] = [];
    const host = createHost(calls, null);
    const wiring = createTeamProvisioningOpenCodeLaunchWiring(host);

    await expect(
      wiring.runOpenCodeTeamRuntimeAdapterLaunch({
        request: request([{ name: 'alice', role: 'Engineer', providerId: 'opencode' }]),
        members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
        prompt: 'launch',
        onProgress: vi.fn(),
      })
    ).rejects.toThrow('OpenCode runtime adapter is not registered');

    expect(calls).toEqual([]);
    expect(host.provisioningRunByTeam.size).toBe(0);
  });

  it('wires runtime adapter launch through host state and service dependencies', async () => {
    const calls: string[] = [];
    const adapter = {
      launch: vi.fn(async () => {
        calls.push('adapter.launch');
        return runtimeResult();
      }),
    } as unknown as TeamLaunchRuntimeAdapter;
    const host = createHost(calls, adapter);
    const wiring = createTeamProvisioningOpenCodeLaunchWiring(host);
    const onProgress = vi.fn();

    const result = await wiring.runOpenCodeTeamRuntimeAdapterLaunch({
      request: request([{ name: 'alice', role: 'Engineer', providerId: 'opencode' }]),
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
      prompt: 'launch',
      onProgress,
    });

    expect(result.runId).toEqual(expect.any(String));
    expect(host.provisioningRunByTeam.has('team-a')).toBe(false);
    expect(host.runtimeAdapterRunByTeam.get('team-a')).toMatchObject({
      providerId: 'opencode',
      cwd: '/repo/runtime',
    });
    expect(host.aliveRuns.get('team-a')).toBe(result.runId);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }));
    expect(calls).toEqual([
      'progress:validating',
      'resetTransientState',
      'readLaunchState',
      'clearPersistedLaunchState',
      'getLaunchCwd',
      'progress:spawning',
      'adapter.launch',
      'persistRuntimeResult',
      'syncApprovals',
      'progress:ready',
      'setAliveRun',
      'invalidateCaches',
      'emit:process:ready',
    ]);
  });

  it('wires aggregate member-lane launch through host state and secondary lane callbacks', async () => {
    const calls: string[] = [];
    const adapter = {} as TeamLaunchRuntimeAdapter;
    const host = createHost(calls, adapter);
    const wiring = createTeamProvisioningOpenCodeLaunchWiring(host);
    const alice = member('alice');
    const bob = member('bob');

    const result = await wiring.runOpenCodeWorktreeRootAggregateLaunch({
      request: request([alice, bob]),
      members: [alice, bob],
      lanePlan: lanePlan({ primaryMembers: [alice], sideMembers: [bob] }),
      prompt: 'launch',
      onProgress: vi.fn(),
    });

    expect(result.runId).toEqual(expect.any(String));
    expect(host.runs.get(result.runId)?.provisioningComplete).toBe(true);
    expect(host.provisioningRunByTeam.has('team-a')).toBe(false);
    expect(host.aliveRuns.get('team-a')).toBe(result.runId);
    expect(calls).toEqual([
      'progress:validating',
      'resetTransientState',
      'readLaunchState',
      'clearPersistedLaunchState',
      'invalidateCaches',
      'progress:spawning',
      'launchPrimary',
      'launchSecondary:secondary:opencode:bob',
      'summarizeAggregateState',
      'persistSnapshot:finished',
      'progress:ready',
      'setAliveRun',
      'invalidateCaches',
      'emit:process:ready',
    ]);
  });
});
