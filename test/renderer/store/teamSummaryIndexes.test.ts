import { describe, expect, it } from 'vitest';

import { buildTeamSummaryIndexes } from '../../../src/renderer/store/team/teamSummaryIndexes';

import type { TeamSummary } from '../../../src/shared/types/team';

const logical: TeamSummary = {
  teamName: 'builders',
  displayName: 'Builders',
  description: '',
  memberCount: 1,
  taskCount: 1,
  lastActivity: null,
  leadSessionId: 'shared-lead',
  sessionHistory: ['shared-old'],
  projectHistoryContexts: [
    {
      executionTeamName: 'ptc-a',
      projectPath: '/sandbox/a',
      leadSessionId: 'a-lead',
      sessionHistory: ['a-old'],
    },
    {
      executionTeamName: 'ptc-b',
      projectPath: '/sandbox/b',
      leadSessionId: 'b-lead',
      sessionHistory: ['b-old'],
    },
  ],
};

describe('buildTeamSummaryIndexes', () => {
  it('keeps logical rows while resolving verified native session ownership', () => {
    const { teamByName, teamBySessionId } = buildTeamSummaryIndexes([logical]);

    expect(Object.keys(teamByName)).toEqual(['builders']);
    expect(teamBySessionId['shared-lead']).toBe(logical);
    expect(teamBySessionId['shared-old']).toBe(logical);
    expect(teamBySessionId['a-lead']).toMatchObject({
      teamName: 'ptc-a', projectPath: '/sandbox/a', displayName: 'Builders',
    });
    expect(teamBySessionId['a-old']?.teamName).toBe('ptc-a');
    expect(teamBySessionId['b-lead']).toMatchObject({
      teamName: 'ptc-b', projectPath: '/sandbox/b',
    });
    expect(teamBySessionId['b-old']?.teamName).toBe('ptc-b');
    expect(teamBySessionId['unrelated-session']).toBeUndefined();
  });

  it('does not infer native ownership without verified project history metadata', () => {
    const { teamBySessionId } = buildTeamSummaryIndexes([{
      ...logical,
      projectHistoryContexts: undefined,
    }]);
    expect(teamBySessionId['a-lead']).toBeUndefined();
    expect(teamBySessionId['shared-lead']?.teamName).toBe('builders');
  });
});
