import { describe, expect, it } from 'vitest';

import {
  buildProjectPathOptions,
  isDeletedProjectPathSelection,
  isSelectableProjectPathProject,
} from '@renderer/components/team/dialogs/projectPathOptions';

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

  it('excludes generated ephemeral project paths', () => {
    const options = buildProjectPathOptions([
      createProject({
        id: 'project-temp',
        name: 'codex-agent-teams-appstyle-zudek6i9',
        path: '/private/var/folders/7b/cache/T/codex-agent-teams-appstyle-zudek6i9',
      }),
      createProject({
        id: 'project-real',
        name: 'claude_team',
        path: '/Users/belief/dev/projects/claude/claude_team',
      }),
    ]);

    expect(options).toEqual([
      {
        value: '/Users/belief/dev/projects/claude/claude_team',
        label: 'claude_team',
        description: '/Users/belief/dev/projects/claude/claude_team',
      },
    ]);
  });

  it('marks deleted project paths as disabled options', () => {
    const options = buildProjectPathOptions([
      createProject({
        id: 'project-deleted',
        name: 'my-tes',
        path: '/Users/belief/dev/projects/my-tes',
        filesystemState: 'deleted',
      }),
    ]);

    expect(options).toEqual([
      {
        value: '/Users/belief/dev/projects/my-tes',
        label: 'my-tes',
        description: '/Users/belief/dev/projects/my-tes',
        disabled: true,
        meta: {
          filesystemState: 'deleted',
        },
      },
    ]);
  });

  it('does not treat deleted project paths as selectable launch targets', () => {
    const deletedProject = createProject({
      id: 'project-deleted',
      name: 'my-tes',
      path: '/Users/belief/dev/projects/my-tes',
      filesystemState: 'deleted',
    });

    expect(isSelectableProjectPathProject(deletedProject)).toBe(false);
    expect(
      isDeletedProjectPathSelection([deletedProject], '/Users/belief/dev/projects/my-tes')
    ).toBe(true);
  });

  it('keeps available project paths selectable', () => {
    const availableProject = createProject({
      id: 'project-available',
      name: 'claude_team',
      path: '/Users/belief/dev/projects/claude/claude_team',
      filesystemState: 'available',
    });

    expect(isSelectableProjectPathProject(availableProject)).toBe(true);
    expect(
      isDeletedProjectPathSelection(
        [availableProject],
        '/Users/belief/dev/projects/claude/claude_team'
      )
    ).toBe(false);
  });
});
