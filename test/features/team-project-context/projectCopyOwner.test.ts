import { describe, expect, it } from 'vitest';

import {
  findProjectCopyOwner,
  formatProjectCopyLabel,
} from '../../../src/features/team-project-context/core';

describe('findProjectCopyOwner / formatProjectCopyLabel', () => {
  const builders = {
    teamName: 'builders',
    displayName: 'Builders',
    projectContextMode: 'per_project' as const,
    projectHistoryContexts: [
      { executionTeamName: 'ptc-one', projectPath: '/work/client-one/app' },
      { executionTeamName: 'ptc-two', projectPath: '/work/client-two/app' },
      { executionTeamName: 'ptc-site', projectPath: 'C:\\work\\site' },
    ],
  };
  const retained = {
    teamName: 'legacy',
    displayName: 'Legacy',
    projectContextMode: 'shared' as const,
    projectHistoryContexts: [{ executionTeamName: 'ptc-old', projectPath: '/work/old' }],
  };

  it('tells two projects of the same folder name apart by their parent folder', () => {
    const label = (name: string) => {
      const owner = findProjectCopyOwner([builders], name);
      return owner ? formatProjectCopyLabel(owner) : name;
    };
    expect(label('ptc-one')).toBe('Builders · client-one/app');
    expect(label('ptc-two')).toBe('Builders · client-two/app');
    expect(label('ptc-site')).toBe('Builders · site');
    expect(label('partner')).toBe('partner');
  });

  it('marks only a per-project owner as the copy own team', () => {
    expect(findProjectCopyOwner([builders, retained], 'ptc-one')?.perProject).toBe(true);
    expect(findProjectCopyOwner([builders, retained], 'ptc-old')).toMatchObject({
      logicalTeamName: 'legacy',
      perProject: false,
    });
    expect(findProjectCopyOwner([builders], 'builders')).toBeNull();
  });
});
