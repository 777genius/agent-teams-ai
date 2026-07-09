import { describe, expect, it } from 'vitest';

import { createTeamProvisioningMemberLifecycleServiceUseCases } from '../TeamProvisioningMemberLifecycleServiceUseCases';

import type { DirectProcessRuntimeEventInput } from '../TeamProvisioningAppendDirectProcessRuntimeEventUseCase';

describe('TeamProvisioningMemberLifecycleServiceUseCases', () => {
  it('creates only the service-owned lifecycle use case ports', async () => {
    const sentMessages: Array<{ teamName: string; message: Record<string, unknown> }> = [];
    const runtimeEvents: DirectProcessRuntimeEventInput[] = [];
    const stoppedMembers: string[] = [];
    const preparedRestartMembers: string[] = [];
    const launchStateReads: string[] = [];

    const useCases = createTeamProvisioningMemberLifecycleServiceUseCases({
      persistSentMessage: (teamName, message) => {
        sentMessages.push({ teamName, message });
      },
      readLaunchStateSnapshot: async (teamName) => {
        launchStateReads.push(teamName);
        return {
          version: 2,
          teamName,
          launchPhase: 'active',
          updatedAt: '2026-07-06T17:00:00.000Z',
          expectedMembers: ['Worker'],
          members: {
            Worker: {
              name: 'Worker',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-07-06T17:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'clean_success',
        };
      },
      appendDirectProcessRuntimeEvent: async (input) => {
        runtimeEvents.push(input);
      },
      stopPrimaryOwnedRosterRuntime: async (input) => {
        stoppedMembers.push(`${input.teamName}:${input.memberName}`);
      },
      preparePrimaryOwnedMemberRestartRuntime: async (input) => {
        preparedRestartMembers.push(`${input.teamName}:${input.memberName}`);
        return {
          directTmuxRestartPaneId: null,
          shouldDirectProcessRestart: true,
        };
      },
      nowIso: () => '2026-07-06T17:00:00.000Z',
      randomUUID: () => 'uuid-1',
    });

    expect(Object.keys(useCases).sort()).toEqual([
      'appendDirectProcessRuntimeEvent',
      'persistOpenCodeMemberRestartSystemMessage',
      'preparePrimaryOwnedMemberRestartRuntime',
      'readOpenCodeSecondaryRetryOutcome',
      'resolveDirectRestartRuntimeCwd',
      'stopPrimaryOwnedRosterRuntime',
      'updateDirectTmuxRestartMemberConfig',
    ]);

    useCases.persistOpenCodeMemberRestartSystemMessage({
      teamName: 'team-a',
      leadName: 'Lead',
      leadSessionId: 'lead-session-1',
      displayName: 'Team A',
      member: { name: 'Worker', role: 'Developer', providerId: 'opencode' },
      reason: 'manual_restart',
    });
    await useCases.appendDirectProcessRuntimeEvent({
      type: 'process_spawned',
      eventsPath: '/safe-test-workspace/team-a/runtime/events.jsonl',
      pid: 123,
      teamName: 'team-a',
      agentName: 'Worker',
      agentId: 'worker@team-a',
      runId: 'lead-session-1',
      bootstrapRunId: 'bootstrap-1',
      source: 'test',
    });
    await useCases.stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Detach for teammate "Worker"',
      persistedRuntimeMembers: [],
      liveRuntimeByMember: new Map(),
    });
    await expect(
      useCases.preparePrimaryOwnedMemberRestartRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        persistedRuntimeMembers: [],
        invalidateRuntimeSnapshotCaches: () => undefined,
        loadLiveRuntimeByMember: async () => new Map(),
      })
    ).resolves.toEqual({
      directTmuxRestartPaneId: null,
      shouldDirectProcessRestart: true,
    });
    await expect(
      useCases.readOpenCodeSecondaryRetryOutcome(
        {
          teamName: 'team-a',
          mixedSecondaryLanes: [],
          memberSpawnStatuses: new Map(),
        },
        'Worker',
        'secondary:opencode:worker'
      )
    ).resolves.toEqual({ launchState: 'confirmed_alive' });
    expect(
      useCases.resolveDirectRestartRuntimeCwd({
        configuredMember: {},
        persistedRuntimeMembers: [{ cwd: ' ' }],
        projectPath: '/safe-test-workspace/team-a',
        runTrackedCwd: '/safe-test-workspace/fallback',
      })
    ).toBe('/safe-test-workspace/team-a');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message).toMatchObject({
      from: 'Lead',
      to: 'Worker',
      timestamp: '2026-07-06T17:00:00.000Z',
      messageId: 'member-restart:team-a:Worker:uuid-1',
      summary: 'Restarting Worker by user request',
    });
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        type: 'process_spawned',
        teamName: 'team-a',
        agentName: 'Worker',
        pid: 123,
      }),
    ]);
    expect(stoppedMembers).toEqual(['team-a:Worker']);
    expect(preparedRestartMembers).toEqual(['team-a:Worker']);
    expect(launchStateReads).toEqual(['team-a']);
  });
});
