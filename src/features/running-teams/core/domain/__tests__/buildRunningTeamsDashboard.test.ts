import { describe, expect, it } from 'vitest';

import {
  buildRunningTeamsDashboard,
  type RunningTeamCandidate,
} from '../policies/buildRunningTeamsDashboard';

function candidate(overrides: Partial<RunningTeamCandidate>): RunningTeamCandidate {
  return {
    teamName: 'team-a',
    displayName: 'Team A',
    projectPath: '/workspace/a',
    lastActivity: null,
    status: 'offline',
    taskCounts: { pending: 0, inProgress: 0, completed: 0 },
    ...overrides,
  };
}

describe('buildRunningTeamsDashboard', () => {
  it('keeps only active, running, and provisioning teams', () => {
    const result = buildRunningTeamsDashboard({
      teams: [
        candidate({ teamName: 'active', displayName: 'Active', status: 'active' }),
        candidate({ teamName: 'idle', displayName: 'Idle', status: 'idle' }),
        candidate({ teamName: 'launching', displayName: 'Launching', status: 'provisioning' }),
        candidate({ teamName: 'offline', displayName: 'Offline', status: 'offline' }),
        candidate({ teamName: 'failed', displayName: 'Failed', status: 'partial_failure' }),
        candidate({ teamName: 'pending', displayName: 'Pending', status: 'partial_pending' }),
        candidate({ teamName: 'skipped', displayName: 'Skipped', status: 'partial_skipped' }),
      ],
    });

    expect(result.map((team) => team.teamName)).toEqual(['active', 'launching', 'idle']);
  });

  it('merges synthetic provisioning teams and sorts by status, work, activity, then name', () => {
    const result = buildRunningTeamsDashboard({
      teams: [
        candidate({
          teamName: 'active-low',
          displayName: 'Active Low',
          status: 'active',
          lastActivity: '2026-05-01T00:00:00.000Z',
          taskCounts: { pending: 0, inProgress: 1, completed: 0 },
        }),
        candidate({
          teamName: 'active-high',
          displayName: 'Active High',
          status: 'active',
          lastActivity: '2026-04-01T00:00:00.000Z',
          taskCounts: { pending: 0, inProgress: 3, completed: 0 },
        }),
        candidate({
          teamName: 'idle-new',
          displayName: 'Idle New',
          status: 'idle',
          lastActivity: '2026-05-03T00:00:00.000Z',
        }),
      ],
      provisioningTeams: [
        candidate({
          teamName: 'launching',
          displayName: 'Launching',
          status: 'provisioning',
          lastActivity: '2026-05-04T00:00:00.000Z',
          taskCounts: { pending: 0, inProgress: 9, completed: 0 },
        }),
        candidate({
          teamName: 'active-low',
          displayName: 'Duplicate Active Low',
          status: 'provisioning',
        }),
      ],
    });

    expect(result.map((team) => team.teamName)).toEqual([
      'active-high',
      'active-low',
      'launching',
      'idle-new',
    ]);
  });
});
