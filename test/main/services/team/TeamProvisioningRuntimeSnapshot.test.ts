import {
  attachLiveRuntimeMetadataToStatuses,
  buildRuntimeDiagnosticForSpawn,
  buildTeamAgentRuntimeSnapshot,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeSnapshot';
import { TeamAgentRuntimeResourceHistory } from '@main/services/team/TeamAgentRuntimeResourceHistory';
import { describe, expect, it } from 'vitest';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
} from '@shared/types';

const baseStatus = (patch: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'spawning',
  launchState: 'starting',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

describe('TeamProvisioningRuntimeSnapshot', () => {
  it('attaches strong live runtime metadata to spawn statuses', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        builder: baseStatus(),
      },
      runtimeByMember: new Map([
        [
          'builder',
          {
            alive: true,
            model: 'gpt-worker',
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'runtime process is alive',
            runtimeDiagnosticSeverity: 'info',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.builder).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      runtimeModel: 'gpt-worker',
      livenessKind: 'runtime_process',
      livenessSource: 'process',
      runtimeDiagnostic: 'runtime process is alive',
      runtimeDiagnosticSeverity: 'info',
    });
  });

  it('does not revive skipped launch members from live runtime metadata', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        reviewer: baseStatus({
          status: 'skipped',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
          hardFailure: true,
          hardFailureReason: 'previous failure',
          error: 'previous failure',
        }),
      },
      runtimeByMember: new Map([
        [
          'reviewer',
          {
            alive: true,
            livenessKind: 'runtime_process',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.reviewer).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      livenessSource: undefined,
    });
  });

  it('heals confirmed native bootstrap-control failures when runtime is alive', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        cody: baseStatus({
          status: 'error',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>',
          error:
            '<agent_teams_native_bootstrap_control> System-level bootstrap rules </agent_teams_native_bootstrap_control>',
        }),
      },
      runtimeByMember: new Map([
        [
          'cody',
          {
            alive: true,
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'verified runtime process detected',
            runtimeDiagnosticSeverity: 'info',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.cody).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
    });
  });

  it('keeps runtime error evidence after healing confirmed native bootstrap-control failures', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        cody: baseStatus({
          status: 'error',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
          error:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
        }),
      },
      runtimeByMember: new Map([
        [
          'cody',
          {
            alive: false,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'Runtime process crashed',
            runtimeDiagnosticSeverity: 'error',
          },
        ],
      ]),
      isOpenCodeBootstrapStallWindowElapsed: () => false,
    });

    expect(result.cody).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      error: undefined,
      livenessKind: 'not_found',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
    });
  });

  it('marks OpenCode secondary bootstrap pending members stalled after the deadline', () => {
    const result = attachLiveRuntimeMetadataToStatuses({
      statuses: {
        implementer: baseStatus({
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      runtimeByMember: new Map(),
      openCodeSecondaryBootstrapPendingMembers: new Set(['implementer']),
      isOpenCodeBootstrapStallWindowElapsed: () => true,
    });

    expect(result.implementer).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      bootstrapStalled: true,
      livenessKind: 'registered_only',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(result.implementer?.runtimeDiagnostic).toContain('bootstrap');
  });

  it('preserves process table unavailable evidence in spawn diagnostics', () => {
    expect(
      buildRuntimeDiagnosticForSpawn({
        alive: false,
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        diagnostics: ['process table unavailable'],
      })
    ).toBe('persisted runtime pid is not alive; process table unavailable');
  });

  it('projects persisted OpenCode host resources while the member remains not alive', async () => {
    const launchSnapshot: PersistedTeamLaunchSnapshot = {
      version: 2,
      teamName: 'runtime-team',
      updatedAt: '2026-04-23T12:26:31.563Z',
      launchPhase: 'finished',
      expectedMembers: ['bob'],
      teamLaunchState: 'partial_pending',
      summary: {
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      members: {
        bob: {
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          runtimePid: 333,
          lastEvaluatedAt: '2026-04-23T12:26:31.563Z',
        },
      },
    };
    const resourceHistory = new TeamAgentRuntimeResourceHistory({
      historyLimit: 60,
      minSampleIntervalMs: 0,
    });

    const snapshot = await buildTeamAgentRuntimeSnapshot({
      teamName: 'runtime-team',
      runId: null,
      generationAtStart: 1,
      runs: new Map<string, never>(),
      runtimeAdapterRunByTeam: new Map<string, never>(),
      teamMetaStore: {
        getMeta: async () => null,
      },
      membersMetaStore: {
        getMembers: async () => [
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      },
      launchStateStore: {
        read: async () => launchSnapshot,
      },
      readConfigSnapshot: async (): Promise<TeamConfig> => ({
        name: 'runtime-team',
        members: [],
      }),
      readPersistedRuntimeMembers: () => [],
      getMemberSpawnStatuses: async () => ({
        statuses: {},
        runId: null,
      }),
      getLiveTeamAgentRuntimeMetadata: async () =>
        new Map([
          [
            'bob',
            {
              alive: false,
              backendType: 'process',
              providerId: 'opencode',
              metricsPid: 333,
              model: 'opencode/minimax-m2.5-free',
              livenessKind: 'runtime_process_candidate',
              pidSource: 'persisted_metadata',
            },
          ],
        ]),
      readRuntimeProcessRowsForUsageSnapshot: async () => [
        {
          pid: 333,
          ppid: 1,
          command: 'opencode runtime host',
          rssBytes: 456_000_000,
          cpuPercent: 2,
        },
      ],
      readProcessUsageStatsByPid: async () => new Map(),
      buildRuntimeUsageProcessTrees: ({ rootPids }) =>
        new Map(rootPids.map((pid) => [pid, { pids: [pid], truncated: false }])),
      buildRuntimeProcessLoadStats: ({ rootPid, scope }) =>
        rootPid === 333
          ? {
              rssBytes: 456_000_000,
              cpuPercent: 2,
              primaryRssBytes: 456_000_000,
              primaryCpuPercent: 2,
              processCount: 1,
              runtimeLoadScope: scope ?? 'single-process',
            }
          : undefined,
      agentRuntimeResourceHistory: resourceHistory,
      getRuntimeSnapshotCacheGeneration: () => 1,
      getTrackedRunId: () => null,
      getAgentRuntimeSnapshotCacheTtlMs: () => 0,
      rememberAgentRuntimeSnapshot: () => undefined,
      logDebug: () => undefined,
    });

    expect(snapshot.members.bob).toMatchObject({
      memberName: 'bob',
      alive: false,
      restartable: false,
      pid: 333,
      providerId: 'opencode',
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: 456_000_000,
      cpuPercent: 2,
      runtimeLoadScope: 'shared-host',
      historicalBootstrapConfirmed: true,
      livenessKind: 'runtime_process_candidate',
      pidSource: 'persisted_metadata',
      runtimePid: 333,
    });
    expect(snapshot.members.bob?.resourceHistory).toEqual([
      expect.objectContaining({
        rssBytes: 456_000_000,
        cpuPercent: 2,
        runtimeLoadScope: 'shared-host',
        pidSource: 'persisted_metadata',
        pid: 333,
        runtimePid: 333,
      }),
    ]);
  });
});
