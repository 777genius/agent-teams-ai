import { describe, expect, it, vi } from 'vitest';

import {
  createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase,
  type OpenCodeControlledRelaunchRuntimeEvidenceLane,
} from '../TeamProvisioningHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

function createSnapshot(
  members: PersistedTeamLaunchSnapshot['members']
): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    launchPhase: 'active',
    updatedAt: '2026-07-09T19:00:00.000Z',
    expectedMembers: Object.keys(members),
    members,
    summary: {
      confirmedCount: 0,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: 'partial_pending',
  };
}

describe('TeamProvisioningHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase', () => {
  it('accepts runtime handles already committed to the lane result', async () => {
    const readLaunchStateSnapshot = vi.fn(async () => null);
    const getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
    const useCase = createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase({
      readLaunchStateSnapshot,
      getLiveTeamAgentRuntimeMetadata,
    });

    await expect(
      useCase({
        teamName: 'team-a',
        memberName: 'Worker',
        laneId: 'secondary:opencode:worker',
        existingLane: {
          result: {
            members: {
              Worker: {
                memberName: 'Worker',
                runtimePid: 1234,
              },
            },
          } as OpenCodeControlledRelaunchRuntimeEvidenceLane['result'],
        },
      })
    ).resolves.toBe(true);
    expect(readLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
  });

  it('accepts persisted liveness evidence by lane id', async () => {
    const readLaunchStateSnapshot = vi.fn(async () =>
      createSnapshot({
        RuntimeWorker: {
          name: 'RuntimeWorker',
          laneId: 'secondary:opencode:worker',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'runtime_process_candidate',
          lastEvaluatedAt: '2026-07-09T19:00:00.000Z',
        },
      })
    );
    const getLiveTeamAgentRuntimeMetadata = vi.fn(async () => new Map());
    const useCase = createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase({
      readLaunchStateSnapshot,
      getLiveTeamAgentRuntimeMetadata,
    });

    await expect(
      useCase({
        teamName: 'team-a',
        memberName: 'Worker',
        laneId: 'secondary:opencode:worker',
        existingLane: null,
      })
    ).resolves.toBe(true);
    expect(readLaunchStateSnapshot).toHaveBeenCalledWith('team-a');
    expect(getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
  });

  it('falls back to live runtime metadata matched by observed member name', async () => {
    const useCase = createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase({
      readLaunchStateSnapshot: vi.fn(async () => null),
      getLiveTeamAgentRuntimeMetadata: vi.fn(
        async () =>
          new Map([
            [
              'Worker-2',
              {
                alive: true,
                livenessKind: 'permission_blocked',
              },
            ],
          ])
      ),
    });

    await expect(
      useCase({
        teamName: 'team-a',
        memberName: 'Worker',
        laneId: 'secondary:opencode:worker',
        existingLane: null,
      })
    ).resolves.toBe(true);
  });

  it('rejects unrelated runtime state as missing reattach evidence', async () => {
    const useCase = createHasOpenCodeMemberRuntimeEvidenceForControlledRelaunchUseCase({
      readLaunchStateSnapshot: vi.fn(async () =>
        createSnapshot({
          Other: {
            name: 'Other',
            laneId: 'secondary:opencode:other',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            lastEvaluatedAt: '2026-07-09T19:00:00.000Z',
          },
        })
      ),
      getLiveTeamAgentRuntimeMetadata: vi.fn(
        async () =>
          new Map([
            [
              'Other',
              {
                alive: true,
                pid: 4321,
              },
            ],
          ])
      ),
    });

    await expect(
      useCase({
        teamName: 'team-a',
        memberName: 'Worker',
        laneId: 'secondary:opencode:worker',
        existingLane: null,
      })
    ).resolves.toBe(false);
  });
});
