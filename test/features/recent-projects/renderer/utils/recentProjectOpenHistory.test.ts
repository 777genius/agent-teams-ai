import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRecentProjectLastOpenedAt,
  recordRecentProjectOpenPaths,
  resetRecentProjectOpenHistoryForTests,
  sortRecentProjectsByDisplayPriority,
} from '@features/recent-projects/renderer/utils/recentProjectOpenHistory';

import type { DashboardRecentProject } from '@features/recent-projects/contracts';

function makeProject(overrides: Partial<DashboardRecentProject> = {}): DashboardRecentProject {
  return {
    id: 'repo:alpha',
    name: 'alpha',
    primaryPath: '/workspace/alpha',
    associatedPaths: ['/workspace/alpha'],
    mostRecentActivity: 1_000,
    providerIds: ['anthropic'],
    source: 'claude',
    openTarget: {
      type: 'existing-worktree',
      repositoryId: 'repo-alpha',
      worktreeId: 'wt-alpha',
    },
    ...overrides,
  };
}

describe('recentProjectOpenHistory', () => {
  beforeEach(() => {
    resetRecentProjectOpenHistoryForTests();
  });

  it('records normalized paths and resolves the latest explicit open across associated paths', () => {
    recordRecentProjectOpenPaths(['/Users/Test/Project/', '/users/test/project'], 5_000);
    recordRecentProjectOpenPaths(['/Users/Test/Project/feature'], 8_000);

    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/users/test/project',
          associatedPaths: ['/users/test/project', '/Users/Test/Project/feature'],
        })
      )
    ).toBe(8_000);
  });

  it('prioritizes explicitly opened projects ahead of raw activity during the priority window', () => {
    const openedProject = makeProject({
      id: 'repo:opened',
      name: 'opened',
      primaryPath: '/workspace/opened',
      associatedPaths: ['/workspace/opened'],
      mostRecentActivity: 5_000,
    });
    const activeProject = makeProject({
      id: 'repo:active',
      name: 'active',
      primaryPath: '/workspace/active',
      associatedPaths: ['/workspace/active'],
      mostRecentActivity: 9_000,
    });

    recordRecentProjectOpenPaths(['/workspace/opened'], 10_000);

    expect(
      sortRecentProjectsByDisplayPriority([activeProject, openedProject], 11_000).map(
        (project) => project.id
      )
    ).toEqual(['repo:opened', 'repo:active']);
  });

  it('falls back to activity sorting after the explicit-open priority window expires', () => {
    const openedProject = makeProject({
      id: 'repo:opened',
      name: 'opened',
      primaryPath: '/workspace/opened',
      associatedPaths: ['/workspace/opened'],
      mostRecentActivity: 5_000,
    });
    const activeProject = makeProject({
      id: 'repo:active',
      name: 'active',
      primaryPath: '/workspace/active',
      associatedPaths: ['/workspace/active'],
      mostRecentActivity: 9_000,
    });

    recordRecentProjectOpenPaths(['/workspace/opened'], 10_000);

    expect(
      sortRecentProjectsByDisplayPriority(
        [activeProject, openedProject],
        10_000 + 1000 * 60 * 60 * 72
      ).map((project) => project.id)
    ).toEqual(['repo:active', 'repo:opened']);
  });

  it('does not collapse distinct case-variant paths when history contains ambiguous entries', () => {
    recordRecentProjectOpenPaths(['/Work/Repo'], 5_000);
    recordRecentProjectOpenPaths(['/work/repo'], 8_000);

    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/Work/Repo',
          associatedPaths: ['/Work/Repo'],
        })
      )
    ).toBe(5_000);

    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/work/repo',
          associatedPaths: ['/work/repo'],
        })
      )
    ).toBe(8_000);

    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/WORK/repo',
          associatedPaths: ['/WORK/repo'],
        })
      )
    ).toBe(0);
  });

  it('does not record generated ephemeral project paths', () => {
    recordRecentProjectOpenPaths(
      ['/private/var/folders/7b/cache/T/codex-agent-teams-appstyle-zudek6i9', '/workspace/opened'],
      10_000
    );

    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/private/var/folders/7b/cache/T/codex-agent-teams-appstyle-zudek6i9',
          associatedPaths: ['/private/var/folders/7b/cache/T/codex-agent-teams-appstyle-zudek6i9'],
        })
      )
    ).toBe(0);
    expect(
      getRecentProjectLastOpenedAt(
        makeProject({
          primaryPath: '/workspace/opened',
          associatedPaths: ['/workspace/opened'],
        })
      )
    ).toBe(10_000);
  });
});
