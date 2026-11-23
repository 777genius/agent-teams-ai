import {
  findTeamProjectSelectionTarget,
  resolveCreateTeamDefaultProjectPath,
  resolveTeamLaunchDefaultProjectPath,
  resolveTeamListProjectPermissionAlias,
  resolveTeamProjectSelection,
  resolveTeamsProjectNavigationPath,
  resolveVerifiedProjectTaskNavigation,
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
  it('keeps an explicit Teams navigation path while its project remains selected', () => {
    expect(
      resolveTeamsProjectNavigationPath(
        { projectId: 'wt-headless', projectPath: '/Users/test/headless' },
        'wt-headless'
      )
    ).toBe('/Users/test/headless');
    expect(
      resolveTeamsProjectNavigationPath(
        { projectId: 'wt-headless', projectPath: '/Users/test/headless' },
        'project-standalone'
      )
    ).toBeNull();
  });

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

  it('launches the selected project after a shared team switches to isolated history', () => {
    expect(
      resolveTeamLaunchDefaultProjectPath(
        'per_project',
        '/Users/test/project-b',
        '/Users/test/legacy-a'
      )
    ).toBe('/Users/test/project-b');
    expect(
      resolveTeamLaunchDefaultProjectPath('shared', '/Users/test/project-b', '/Users/test/legacy-a')
    ).toBe('/Users/test/legacy-a');
    expect(resolveTeamLaunchDefaultProjectPath(undefined, '/Users/test/project-b', null)).toBe(
      '/Users/test/project-b'
    );
  });

  it('uses only a verified runtime owned by the selected project for relaunch permissions', () => {
    const ready = {
      mode: 'per_project' as const,
      state: 'ready' as const,
      executionTeamName: 'ptc-project-b',
      workContextId: 'ctx-b',
      projectPath: '/Users/test/project-b',
    };
    expect(
      resolveTeamListProjectPermissionAlias('logical-team', '/users/test/project-b/', ready)
    ).toBe('ptc-project-b');
    expect(
      resolveTeamListProjectPermissionAlias('logical-team', '/Users/test/project-a', ready)
    ).toBeNull();
    expect(
      resolveTeamListProjectPermissionAlias('logical-team', '/Users/test/project-b', {
        ...ready,
        executionTeamName: 'logical-team',
      })
    ).toBeNull();
    expect(
      resolveTeamListProjectPermissionAlias('logical-team', '/Users/test/project-b', {
        mode: 'per_project',
        state: 'pending',
        reason: 'launching',
        projectPath: '/Users/test/project-b',
        runId: null,
      })
    ).toBeNull();
    expect(
      resolveTeamListProjectPermissionAlias('logical-team', '/Users/test/project-b', {
        mode: 'shared',
        state: 'ready',
        executionTeamName: 'logical-team',
      })
    ).toBeNull();
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

  it('keeps verified physical task history when its project is no longer discovered', () => {
    const verified = {
      mode: 'per_project' as const,
      state: 'redirect' as const,
      logicalTeamName: 'builders',
      projectPath: '/Users/test/deleted-worktree',
    };
    expect(
      resolveVerifiedProjectTaskNavigation('ptc-owned', verified, repositoryGroups, projects)
    ).toEqual({ teamName: 'ptc-owned' });
    expect(
      resolveVerifiedProjectTaskNavigation(
        'ptc-owned',
        { ...verified, projectPath: '/Users/test/headless' },
        repositoryGroups,
        projects
      )
    ).toEqual({ teamName: 'builders', projectPath: '/Users/test/headless' });
    expect(
      resolveVerifiedProjectTaskNavigation(
        'ptc-owned',
        { ...verified, projectPath: '/Users/test/standalone' },
        repositoryGroups,
        projects
      )
    ).toEqual({ teamName: 'builders', projectPath: '/Users/test/standalone' });
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
