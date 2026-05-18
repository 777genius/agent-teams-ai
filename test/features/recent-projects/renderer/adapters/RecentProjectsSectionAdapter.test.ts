import { describe, expect, it } from 'vitest';

import { adaptRecentProjectsSection } from '@features/recent-projects/renderer/adapters/RecentProjectsSectionAdapter';

import type { DashboardRecentProject } from '@features/recent-projects/contracts';
import type { TeamSummary } from '@shared/types';

describe('adaptRecentProjectsSection', () => {
  it('sorts providers, aggregates decorations, and builds a path summary for merged cards', () => {
    const project: DashboardRecentProject = {
      id: 'repo:alpha',
      name: 'alpha',
      primaryPath: '/Users/test/alpha',
      associatedPaths: ['/Users/test/alpha', '/Users/test/alpha-worktree'],
      mostRecentActivity: Date.parse('2026-04-14T12:00:00Z'),
      providerIds: ['codex', 'anthropic'],
      source: 'mixed',
      openTarget: {
        type: 'existing-worktree',
        repositoryId: 'repo-alpha',
        worktreeId: 'wt-alpha',
      },
      primaryBranch: 'main',
      filesystemState: 'deleted',
    };

    const activeTeam: TeamSummary = {
      teamName: 'alpha-team',
      displayName: 'Alpha Team',
      description: 'Alpha team',
      memberCount: 0,
      taskCount: 0,
      projectPath: '/Users/test/alpha-worktree',
      lastActivity: null,
    };

    const cards = adaptRecentProjectsSection({
      projects: [project],
      taskCountsByProject: new Map([
        ['/users/test/alpha', { pending: 1, inProgress: 2, completed: 3 }],
        ['/users/test/alpha-worktree', { pending: 4, inProgress: 5, completed: 6 }],
      ]),
      activeTeamsByProject: new Map([
        ['/users/test/alpha', [activeTeam]],
        ['/users/test/alpha-worktree', [activeTeam]],
      ]),
      tasksLoading: false,
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      providerIds: ['anthropic', 'codex'],
      taskCounts: { pending: 5, inProgress: 7, completed: 9 },
      additionalPathCount: 1,
      primaryBranch: 'main',
      filesystemState: 'deleted',
      activeTeams: [activeTeam],
      pathSummary: {
        badgeLabel: '2 paths',
        description: 'This card merges recent activity from related worktrees and project paths.',
        paths: [
          {
            label: 'Primary path',
            fullPath: '/Users/test/alpha',
          },
          {
            label: 'Related path 1',
            fullPath: '/Users/test/alpha-worktree',
          },
        ],
      },
    });
  });
});
