import { describe, expect, it } from 'vitest';

import { TeamDirectoryOrganizationAdapter } from '../../../src/features/organizations/main/adapters/output/TeamDirectoryOrganizationAdapter';

import type { TeamDataService } from '../../../src/main/services/team/TeamDataService';
import type { GlobalTask, TeamSummary } from '../../../src/shared/types';

function team(teamName: string, patch: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName,
    displayName: 'Builders',
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    ...patch,
  };
}

function task(teamName: string, id: string, status: GlobalTask['status'] = 'pending'): GlobalTask {
  return { id, subject: `task ${id}`, status, teamName, teamDisplayName: 'Builders' } as GlobalTask;
}

function service(teams: TeamSummary[], tasks: GlobalTask[], alive: string[]): TeamDataService {
  return {
    listTeams: async () => teams,
    getAllTasks: async () => tasks,
    listAliveProcessTeams: async () => alive,
  } as unknown as TeamDataService;
}

const rawTeams = [
  team('builders', { pendingCreate: true }),
  team('ptc-a'),
  team('ptc-b'),
  team('legacy', { displayName: 'Legacy' }),
];
const rawTasks = [task('ptc-a', '1'), task('ptc-b', '1', 'in_progress'), task('legacy', '1')];

/** What projectTeamSummaries does to the raw list: folds the copies into the logical team. */
const fold = async (teams: TeamSummary[]): Promise<TeamSummary[]> =>
  teams
    .filter((row) => !row.teamName.startsWith('ptc-'))
    .map((row) =>
      row.teamName === 'builders'
        ? {
            ...row,
            pendingCreate: false,
            projectContextMode: 'per_project' as const,
            projectHistoryContexts: [
              { executionTeamName: 'ptc-a', projectPath: '/p/a' },
              { executionTeamName: 'ptc-b', projectPath: '/p/b' },
            ],
          }
        : row
    );

describe('TeamDirectoryOrganizationAdapter', () => {
  it('offers one candidate for a per-project team, with the tasks of every context', async () => {
    const adapter = new TeamDirectoryOrganizationAdapter(service(rawTeams, rawTasks, []), fold);
    const candidates = await adapter.listTeams({ includeDeletedTeams: false });
    expect(candidates.map((candidate) => candidate.teamName).sort()).toEqual(['builders', 'legacy']);
    const logical = candidates.find((candidate) => candidate.teamName === 'builders');
    expect(logical?.pendingCreate).toBe(false);
    expect(logical?.tasks).toHaveLength(2);
    expect(logical?.tasks.map((candidate) => candidate.status).sort()).toEqual([
      'in_progress',
      'pending',
    ]);
  });

  it('is online when any project context is alive', async () => {
    const adapter = new TeamDirectoryOrganizationAdapter(
      service(rawTeams, rawTasks, ['ptc-b']),
      fold
    );
    const candidates = await adapter.listTeams({ includeDeletedTeams: false });
    expect(candidates.find((candidate) => candidate.teamName === 'builders')?.isOnline).toBe(true);
    expect(candidates.find((candidate) => candidate.teamName === 'legacy')?.isOnline).toBe(false);
  });

  it('does not fold anything without a projection port (ordinary teams are unchanged)', async () => {
    const adapter = new TeamDirectoryOrganizationAdapter(service(rawTeams, rawTasks, ['legacy']));
    const candidates = await adapter.listTeams({ includeDeletedTeams: false });
    expect(candidates).toHaveLength(4);
    expect(candidates.find((candidate) => candidate.teamName === 'legacy')).toMatchObject({
      isOnline: true,
    });
  });
});
