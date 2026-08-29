import { describe, expect, it } from 'vitest';

import { chooseActiveRunLaunchSnapshot } from '../TeamProvisioningActiveRunLaunchSnapshot';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

function snapshot(runId: string | undefined, memberNames: string[]): PersistedTeamLaunchSnapshot {
  return {
    version: 3,
    teamName: 'team-a',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...(runId ? { runtimeRunId: runId } : {}),
    launchPhase: 'active',
    expectedMembers: memberNames,
    members: Object.fromEntries(
      memberNames.map((name) => [
        name,
        {
          name,
          providerId: 'opencode',
          model: 'opencode/current',
          ...(runId ? { runtimeRunId: runId } : {}),
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-08-25T00:00:00.000Z',
        },
      ])
    ),
    summary: {
      confirmedCount: memberNames.length,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: 'clean_success',
  };
}

describe('chooseActiveRunLaunchSnapshot', () => {
  it('keeps the exact durable launch identity when richer bootstrap evidence shares the run', () => {
    const bootstrapRuntime = snapshot('run-current', ['team-lead', 'alice', 'bob']);
    const currentLaunch = snapshot('run-current', ['team-lead', 'alice']);

    expect(chooseActiveRunLaunchSnapshot(bootstrapRuntime, currentLaunch, 'run-current')).toBe(
      currentLaunch
    );
  });

  it('preserves normal preference when neither candidate owns the active run', () => {
    const richerBootstrap = snapshot('run-old', ['team-lead', 'alice', 'bob']);
    const staleLaunch = snapshot('run-older', ['team-lead']);

    expect(chooseActiveRunLaunchSnapshot(richerBootstrap, staleLaunch, 'run-current')).toBe(
      richerBootstrap
    );
  });
});
