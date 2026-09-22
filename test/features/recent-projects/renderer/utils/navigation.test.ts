import { describe, expect, it, vi } from 'vitest';

import {
  buildSyntheticRepositoryGroup,
  encodeProjectPathForNavigation,
  findMatchingWorktree,
} from '@features/recent-projects/renderer/utils/navigation';

import type { RepositoryGroup } from '@renderer/types/data';

describe('recent-projects navigation utils', () => {
  it('finds a matching worktree across normalized candidate paths', () => {
    const groups: RepositoryGroup[] = [
      {
        id: 'repo-alpha',
        identity: null,
        name: 'alpha',
        mostRecentSession: 1_000,
        totalSessions: 2,
        worktrees: [
          {
            id: 'wt-alpha',
            path: '/Users/test/Alpha',
            name: 'alpha',
            isMainWorktree: true,
            source: 'unknown',
            sessions: [],
            totalSessions: 2,
            createdAt: 1_000,
          },
        ],
      },
    ];

    expect(findMatchingWorktree(groups, ['/users/test/alpha/', '/users/test/other'])).toEqual({
      repoId: 'repo-alpha',
      worktreeId: 'wt-alpha',
    });
  });

  it('builds a synthetic repository group with encoded repo and worktree ids', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));

    const group = buildSyntheticRepositoryGroup('/Users/test/dev/my project');

    expect(group.id).toBe('-Users-test-dev-my project');
    expect(group.name).toBe('my project');
    expect(group.worktrees).toHaveLength(1);
    expect(group.worktrees[0]).toMatchObject({
      id: '-Users-test-dev-my project',
      path: '/Users/test/dev/my project',
      name: 'my project',
      isMainWorktree: true,
      totalSessions: 0,
    });
    expect(group.worktrees[0].createdAt).toBe(Date.parse('2026-04-14T12:00:00Z'));

    vi.useRealTimers();
  });

  it('encodes Windows custom project paths with the same drive format as session ids', () => {
    expect(encodeProjectPathForNavigation('C:\\Users\\User\\PROJECT_IT\\сlaude_team')).toBe(
      'C--Users-User-PROJECT_IT-сlaude_team'
    );
  });
});
