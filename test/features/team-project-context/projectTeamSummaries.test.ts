import { describe, expect, it, vi } from 'vitest';

import { projectTeamSummaries } from '../../../src/features/team-project-context/main/projectTeamSummaries';

import type { TeamSummary } from '../../../src/shared/types/team';
import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';
import type { PersistedTeamWorkContext } from '../../../src/features/team-project-context/main';

const teams: TeamSummary[] = [
  { teamName: 'builders', displayName: 'Builders', description: '', memberCount: 1, taskCount: 0, lastActivity: null },
  { teamName: 'ptc-owned', displayName: 'Builders', description: '', memberCount: 1, taskCount: 3, lastActivity: null },
  { teamName: 'ptc-foreign', displayName: 'Foreign', description: '', memberCount: 1, taskCount: 0, lastActivity: null },
  { teamName: 'old-team', displayName: 'Old team', description: '', memberCount: 1, taskCount: 0, lastActivity: null },
];

const ctx: PersistedTeamWorkContext = {
  id: '11111111-1111-4111-8111-111111111111', projectKey: '/sandbox/a', projectPath: '/sandbox/a',
  executionTeamName: 'ptc-owned', state: 'ready',
};

function fixture() {
  const meta = { getMeta: vi.fn(async (name: string): Promise<TeamMetaFile | null> => name === 'builders'
    ? { version: 1 as const, cwd: '/sandbox/a', createdAt: 1, projectContextMode: 'per_project' as const }
    : null) };
  const registry = { list: vi.fn(async () => [ctx]), listRetained: vi.fn(async () => [ctx]) };
  return { meta, registry };
}

describe('projectTeamSummaries', () => {
  it('shows only one logical team row and preserves unrelated native/foreign teams', async () => {
    const f = fixture();
    const visible = await projectTeamSummaries(teams, f.meta, f.registry);
    expect(visible.map((v) => v.teamName)).toEqual(['builders', 'ptc-foreign', 'old-team']);
    expect(visible[0]?.projectContextMode).toBe('per_project');
    expect(visible[0]?.pendingCreate).toBe(false);
    expect(visible[0]?.taskCount).toBe(3);
    expect(visible[0]?.projectHistoryContexts).toEqual([
      { executionTeamName: 'ptc-owned', projectPath: '/sandbox/a', memberCount: 1 },
    ]);
  });

  it('retains verified physical lead and historical session IDs without showing alias rows', async () => {
    const f = fixture();
    const nativeTeams = teams.map((team) => team.teamName === 'ptc-owned'
      ? { ...team, leadSessionId: 'physical-lead', sessionHistory: ['physical-old'] }
      : team);
    const visible = await projectTeamSummaries(nativeTeams, f.meta, f.registry);
    expect(visible.map((team) => team.teamName)).toEqual([
      'builders', 'ptc-foreign', 'old-team',
    ]);
    expect(visible[0]?.projectHistoryContexts).toEqual([{
      executionTeamName: 'ptc-owned',
      projectPath: '/sandbox/a',
      memberCount: 1,
      leadSessionId: 'physical-lead',
      sessionHistory: ['physical-old'],
    }]);
  });

  it('keeps owned native aliases hidden for a team whose saved mode is shared', async () => {
    const f = fixture();
    f.meta.getMeta.mockImplementation(async (name: string) => name === 'builders'
      ? { version: 1 as const, cwd: '/sandbox/a', createdAt: 1, projectContextMode: 'shared' as const }
      : null);
    const visible = await projectTeamSummaries(teams, f.meta, f.registry);
    expect(visible.map((v) => v.teamName)).toEqual(['builders', 'ptc-foreign', 'old-team']);
    expect(visible[0]?.projectContextMode).toBe('shared');
    expect(f.registry.listRetained).toHaveBeenCalledWith('builders');
    expect(visible[0]?.projectHistoryContexts).toEqual([
      { executionTeamName: 'ptc-owned', projectPath: '/sandbox/a', memberCount: 1 },
    ]);
  });

  it('does not invent a solo member count for an owned context without a native summary', async () => {
    const f = fixture();
    const withoutNative = teams.filter((team) => team.teamName !== 'ptc-owned');
    const visible = await projectTeamSummaries(withoutNative, f.meta, f.registry);
    expect(visible[0]?.projectHistoryContexts).toEqual([
      { executionTeamName: 'ptc-owned', projectPath: '/sandbox/a' },
    ]);
  });

  it('does not trust a pending reservation as authority to hide a physical team', async () => {
    const f = fixture();
    f.registry.list.mockResolvedValue([{ ...ctx, state: 'reserved' }]);
    const visible = await projectTeamSummaries(teams, f.meta, f.registry);
    expect(visible.some((t) => t.teamName === 'ptc-owned')).toBe(true);
    expect(visible.find((t) => t.teamName === 'builders')?.projectHistoryContexts).toBeUndefined();
  });

  it('fails open for visibility, never silently hides teams after mapping errors', async () => {
    const f = fixture();
    f.registry.list.mockRejectedValue(new Error('corrupt index'));
    expect((await projectTeamSummaries(teams, f.meta, f.registry)).length).toBe(teams.length);
  });
});
