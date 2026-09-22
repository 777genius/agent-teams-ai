import { describe, expect, it, vi } from 'vitest';

import {
  createReadOpenCodeSecondaryRetryOutcomeUseCase,
  type ReadOpenCodeSecondaryRetryOutcomeRun,
} from '../TeamProvisioningReadOpenCodeSecondaryRetryOutcomeUseCase';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const EVALUATED_AT = '2026-07-06T17:00:00.000Z';

function createRun(
  overrides: Partial<
    Pick<ReadOpenCodeSecondaryRetryOutcomeRun, 'mixedSecondaryLanes' | 'memberSpawnStatuses'>
  > = {}
): ReadOpenCodeSecondaryRetryOutcomeRun {
  return {
    teamName: 'team-a',
    mixedSecondaryLanes: [],
    memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>(),
    ...overrides,
  };
}

function createPersistedMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Worker',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}

function createSnapshot(
  members: PersistedTeamLaunchSnapshot['members']
): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    launchPhase: 'active',
    updatedAt: EVALUATED_AT,
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

describe('createReadOpenCodeSecondaryRetryOutcomeUseCase', () => {
  it('confirms a retried lane from launch evidence', async () => {
    const readLaunchStateSnapshot = vi.fn(async () => null);
    const readOutcome = createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot,
    });
    const run = createRun({
      mixedSecondaryLanes: [
        {
          laneId: 'secondary:opencode:worker',
          member: { name: 'Worker' },
          result: {
            members: {
              Worker: {
                memberName: 'Worker',
                bootstrapConfirmed: true,
              },
            },
          },
        } as never,
      ],
    });

    await expect(readOutcome(run, 'Worker', 'secondary:opencode:worker')).resolves.toEqual({
      launchState: 'confirmed_alive',
    });
    expect(readLaunchStateSnapshot).toHaveBeenCalledWith('team-a');
  });

  it('returns skipped outcomes with the live skip reason before failure checks', async () => {
    const readOutcome = createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot: async () =>
        createSnapshot({
          Worker: createPersistedMember({
            launchState: 'failed_to_start',
            hardFailure: true,
            hardFailureReason: 'persisted failure',
          }),
        }),
    });
    const run = createRun({
      memberSpawnStatuses: new Map([
        [
          'Worker',
          {
            launchState: 'skipped_for_launch',
            skippedForLaunch: true,
            skipReason: 'User skipped launch',
          } as MemberSpawnStatusEntry,
        ],
      ]),
    });

    await expect(readOutcome(run, 'Worker', 'secondary:opencode:worker')).resolves.toEqual({
      launchState: 'skipped_for_launch',
      reason: 'User skipped launch',
    });
  });

  it('returns failed outcomes with the first non-empty diagnostic trimmed', async () => {
    const readOutcome = createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot: async () => null,
    });
    const run = createRun({
      mixedSecondaryLanes: [
        {
          laneId: 'secondary:opencode:worker',
          member: { name: 'Worker' },
          result: {
            members: {
              Worker: {
                memberName: 'Worker',
                hardFailure: true,
                hardFailureReason: '   ',
                runtimeDiagnostic: '  lane failed to bootstrap  ',
                diagnostics: ['later diagnostic'],
              },
            },
          },
        } as never,
      ],
    });

    await expect(readOutcome(run, 'Worker', 'secondary:opencode:worker')).resolves.toEqual({
      launchState: 'failed_to_start',
      reason: 'lane failed to bootstrap',
    });
  });

  it('falls back to live pending state when persisted launch state cannot be read', async () => {
    const readOutcome = createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot: async () => {
        throw new Error('read failed');
      },
    });
    const run = createRun({
      memberSpawnStatuses: new Map([
        [
          'Worker',
          {
            launchState: 'runtime_pending_permission',
          } as MemberSpawnStatusEntry,
        ],
      ]),
    });

    await expect(readOutcome(run, 'Worker', 'secondary:opencode:worker')).resolves.toEqual({
      launchState: 'runtime_pending_permission',
    });
  });
});
