import { describe, expect, it } from 'vitest';

import { resolveEffectiveSelectedRepositoryId } from '../../../../src/renderer/components/sidebar/dateGroupedSessionsSelection';

import type { RepositoryGroup } from '@renderer/types/data';

function createRepositoryGroup(id: string, worktreeId: string, path: string): RepositoryGroup {
  return {
    id,
    identity: null,
    name: id,
    totalSessions: 0,
    worktrees: [
      {
        id: worktreeId,
        path,
        name: worktreeId,
        isMainWorktree: true,
        source: 'git',
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
      },
    ],
  };
}

describe('resolveEffectiveSelectedRepositoryId', () => {
  it('falls back to the repository that owns the active worktree when repository selection is empty', () => {
    const repositoryGroups = [
      createRepositoryGroup(
        'repo-headless',
        'worktree-headless',
        '/Users/belief/dev/projects/headless'
      ),
      createRepositoryGroup('repo-other', 'worktree-other', '/Users/belief/dev/projects/other'),
    ];

    expect(
      resolveEffectiveSelectedRepositoryId({
        repositoryGroups,
        selectedRepositoryId: null,
        effectiveSelectedWorktreeId: 'worktree-headless',
      })
    ).toBe('repo-headless');
  });

  it('keeps the explicit repository selection when it already exists', () => {
    const repositoryGroups = [
      createRepositoryGroup(
        'repo-headless',
        'worktree-headless',
        '/Users/belief/dev/projects/headless'
      ),
    ];

    expect(
      resolveEffectiveSelectedRepositoryId({
        repositoryGroups,
        selectedRepositoryId: 'repo-headless',
        effectiveSelectedWorktreeId: 'worktree-headless',
      })
    ).toBe('repo-headless');
  });

  it('falls back to the worktree owner when the explicit repository selection is stale', () => {
    const repositoryGroups = [
      createRepositoryGroup(
        'repo-headless',
        'worktree-headless',
        '/Users/belief/dev/projects/headless'
      ),
    ];

    expect(
      resolveEffectiveSelectedRepositoryId({
        repositoryGroups,
        selectedRepositoryId: 'repo-stale',
        effectiveSelectedWorktreeId: 'worktree-headless',
      })
    ).toBe('repo-headless');
  });

  it('prefers the repository that owns the active worktree over a different valid repository', () => {
    const repositoryGroups = [
      createRepositoryGroup(
        'repo-headless',
        'worktree-headless',
        '/Users/belief/dev/projects/headless'
      ),
      createRepositoryGroup('repo-other', 'worktree-other', '/Users/belief/dev/projects/other'),
    ];

    expect(
      resolveEffectiveSelectedRepositoryId({
        repositoryGroups,
        selectedRepositoryId: 'repo-other',
        effectiveSelectedWorktreeId: 'worktree-headless',
      })
    ).toBe('repo-headless');
  });
});
