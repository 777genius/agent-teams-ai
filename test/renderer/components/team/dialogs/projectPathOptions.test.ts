import { describe, expect, it } from 'vitest';

import { buildProjectPathOptions } from '@renderer/components/team/dialogs/projectPathOptions';

import type { Project } from '@shared/types';

function createProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-id',
    name: 'project',
    path: '/Users/test/project',
    sessions: [],
    totalSessions: 0,
    createdAt: 1,
    ...overrides,
  };
}

describe('buildProjectPathOptions', () => {
  it('removes duplicate projects that point to the same path', () => {
    const options = buildProjectPathOptions([
      createProject({
        id: 'project-1',
        name: 'lintai',
        path: '/Users/belief/dev/projects/lintai',
      }),
      createProject({
        id: 'project-2',
        name: 'lintai duplicate',
        path: '/Users/belief/dev/projects/lintai',
      }),
    ]);

    expect(options).toEqual([
      {
        value: '/Users/belief/dev/projects/lintai',
        label: 'lintai',
        description: '/Users/belief/dev/projects/lintai',
      },
    ]);
  });

  it('prefers the currently selected variant when duplicate paths normalize equally', () => {
    const options = buildProjectPathOptions(
      [
        createProject({
          id: 'project-1',
          name: 'LintAI',
          path: '/Users/Belief/dev/projects/lintai',
        }),
        createProject({
          id: 'project-2',
          name: 'lintai',
          path: '/Users/belief/dev/projects/lintai/',
        }),
      ],
      '/Users/belief/dev/projects/lintai/'
    );

    expect(options).toEqual([
      {
        value: '/Users/belief/dev/projects/lintai/',
        label: 'lintai',
        description: '/Users/belief/dev/projects/lintai/',
      },
    ]);
  });
});
