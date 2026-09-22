import { describe, expect, it } from 'vitest';

import { buildActiveTeamsByProject } from '@features/recent-projects/renderer/utils/activeProjectTeams';

import type { TeamSummary } from '@shared/types';

function makeTeamSummary(
  overrides: Partial<TeamSummary> & Pick<TeamSummary, 'teamName' | 'displayName'>
): TeamSummary {
  return {
    ...overrides,
    description: overrides.description ?? '',
    memberCount: overrides.memberCount ?? 0,
    taskCount: overrides.taskCount ?? 0,
    lastActivity: overrides.lastActivity ?? null,
    teamName: overrides.teamName,
    displayName: overrides.displayName,
  };
}

describe('buildActiveTeamsByProject', () => {
  it('treats provisioning-active existing teams as active before aliveList catches up', () => {
    const lintai = makeTeamSummary({
      teamName: 'signal-ops-3',
      displayName: 'signal-ops-3',
      projectPath: '/Users/test/lintai',
    });

    const teamsByProject = buildActiveTeamsByProject({
      teams: [lintai],
      aliveTeamNames: [],
      provisioningTeamNames: ['signal-ops-3'],
      provisioningSnapshotByTeam: {},
    });

    expect(teamsByProject.get('/users/test/lintai')).toEqual([lintai]);
  });

  it('includes synthetic provisioning snapshots for teams not yet present in team summaries', () => {
    const provisioningSnapshot = makeTeamSummary({
      teamName: 'northstar-team',
      displayName: 'Northstar Team',
      projectPath: '/Users/test/northstar',
    });

    const teamsByProject = buildActiveTeamsByProject({
      teams: [],
      aliveTeamNames: [],
      provisioningTeamNames: ['northstar-team'],
      provisioningSnapshotByTeam: {
        'northstar-team': provisioningSnapshot,
      },
    });

    expect(teamsByProject.get('/users/test/northstar')).toEqual([provisioningSnapshot]);
  });
});
