import {
  findTeamProjectSelectionTarget,
  resolveCreateTeamDefaultProjectPath,
  resolveTeamProjectSelection,
  teamMatchesProjectSelection,
} from '@renderer/components/team/teamProjectSelection';
import { describe, expect, it } from 'vitest';

import type { Project, RepositoryGroup } from '@renderer/types/data';
import type { TeamSummary } from '@shared/types';

const repositoryGroups: RepositoryGroup[] = [
  {
    id: 'repo-headless',
    identity: null,
    name: 'headless',
    mostRecentSession: 1,
    totalSessions: 5,
    worktrees: [
      {
        id: 'wt-headless',
        path: '/Users/test/headless',
        name: 'headless',
        isMainWorktree: true,
        source: 'git',
        sessions: [],
        totalSessions: 5,
        createdAt: 1,
      },
    ],
  },
];

const projects: Project[] = [
  {
    id: 'project-standalone',
    name: 'standalone',
    path: '/Users/test/standalone',
    sessions: [],
    totalSessions: 2,
    createdAt: 1,
  },
];

describe('teamProjectSelection', () => {
  it('resolves selected grouped worktree path', () => {
    expect(
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId: 'repo-headless',
        selectedWorktreeId: 'wt-headless',
        selectedProjectId: 'wt-headless',
        activeProjectId: 'wt-headless',
      })
    ).toEqual({
      projectPath: '/Users/test/headless',
      repositoryId: 'repo-headless',
      worktreeId: 'wt-headless',
      projectId: 'wt-headless',
    });
  });

  it('falls back to active project id when grouped ids are stale', () => {
    expect(
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId: null,
        selectedWorktreeId: null,
        selectedProjectId: null,
        activeProjectId: 'wt-headless',
      })
    ).toEqual({
      projectPath: '/Users/test/headless',
      repositoryId: 'repo-headless',
      worktreeId: 'wt-headless',
      projectId: 'wt-headless',
    });
  });

  it('prefers the selected project over the active project', () => {
    expect(
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId: null,
        selectedWorktreeId: null,
        selectedProjectId: 'project-standalone',
        activeProjectId: 'wt-headless',
      })
    ).toEqual({
      projectPath: '/Users/test/standalone',
      repositoryId: null,
      worktreeId: null,
      projectId: 'project-standalone',
    });
  });

  it('prefers a selected flat project over a stale selected worktree', () => {
    expect(
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId: 'repo-headless',
        selectedWorktreeId: 'wt-headless',
        selectedProjectId: 'project-standalone',
        activeProjectId: 'wt-headless',
      })
    ).toEqual({
      projectPath: '/Users/test/standalone',
      repositoryId: null,
      worktreeId: null,
      projectId: 'project-standalone',
    });
  });

  it('prefers copied project path over selected and priority project paths for create defaults', () => {
    expect(
      resolveCreateTeamDefaultProjectPath({
        initialProjectPath: '/Users/test/copied',
        selectedProjectPath: '/Users/test/selected',
        priorityProjectPath: '/Users/test/priority',
      })
    ).toBe('/Users/test/copied');
  });

  it('prefers selected project path over stale priority project path for create defaults', () => {
    expect(
      resolveCreateTeamDefaultProjectPath({
        initialProjectPath: null,
        selectedProjectPath: '/Users/test/selected',
        priorityProjectPath: '/Users/test/priority',
      })
    ).toBe('/Users/test/selected');
  });

  it('uses priority project path as a create default fallback', () => {
    expect(
      resolveCreateTeamDefaultProjectPath({
        initialProjectPath: null,
        selectedProjectPath: null,
        priorityProjectPath: '/Users/test/priority',
      })
    ).toBe('/Users/test/priority');
  });

  it('falls back to the active project when the selected project id is stale', () => {
    expect(
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId: null,
        selectedWorktreeId: null,
        selectedProjectId: 'missing-project',
        activeProjectId: 'wt-headless',
      })
    ).toEqual({
      projectPath: '/Users/test/headless',
      repositoryId: 'repo-headless',
      worktreeId: 'wt-headless',
      projectId: 'wt-headless',
    });
  });

  it('finds grouped selection target by project path', () => {
    expect(
      findTeamProjectSelectionTarget(repositoryGroups, projects, '/users/test/headless/')
    ).toEqual({
      kind: 'grouped',
      repositoryId: 'repo-headless',
      worktreeId: 'wt-headless',
      projectPath: '/Users/test/headless',
    });
  });

  it('falls back to flat projects when no grouped worktree exists', () => {
    expect(
      findTeamProjectSelectionTarget(repositoryGroups, projects, '/users/test/standalone/')
    ).toEqual({
      kind: 'flat',
      projectId: 'project-standalone',
      projectPath: '/Users/test/standalone',
    });
  });

  it('matches team project history against the selected project', () => {
    const team = {
      teamName: 'demo-team',
      displayName: 'Demo Team',
      description: '',
      memberCount: 0,
      taskCount: 0,
      projectPath: '/Users/test/other',
      projectPathHistory: ['/Users/test/headless', '/Users/test/archive'],
      lastActivity: null,
      members: [],
    } satisfies TeamSummary;

    expect(teamMatchesProjectSelection(team, '/users/test/headless')).toBe(true);
    expect(teamMatchesProjectSelection(team, '/users/test/missing')).toBe(false);
  });
});
