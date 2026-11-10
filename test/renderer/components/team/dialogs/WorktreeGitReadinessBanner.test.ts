import { describe, expect, it } from 'vitest';

import {
  getWorktreeGitBlockingMessage,
  getWorktreeGitControlDisabledReason,
} from '@renderer/components/team/dialogs/WorktreeGitReadinessBanner';

describe('WorktreeGitReadinessBanner helpers', () => {
  it('does not block submit when no teammate selected worktree isolation', () => {
    expect(
      getWorktreeGitBlockingMessage(
        {
          loading: false,
          error: null,
          status: {
            projectPath: '/project',
            isGitRepo: false,
            hasHead: false,
            canUseWorktrees: false,
            reason: 'not_git_repo',
            message: 'not ready',
          },
        },
        false
      )
    ).toBeNull();
  });

  it('blocks selected worktree isolation until git has a HEAD commit', () => {
    const state = {
      loading: false,
      error: null,
      status: {
        projectPath: '/project',
        isGitRepo: true,
        hasHead: false,
        canUseWorktrees: false,
        reason: 'missing_head' as const,
        message: 'Create an initial commit before using worktrees.',
      },
    };

    expect(getWorktreeGitBlockingMessage(state, true)).toBe(
      'Create an initial commit before using worktrees.'
    );
    expect(getWorktreeGitControlDisabledReason(state)).toBe(
      'Create an initial commit before using worktrees.'
    );
  });

  it('allows worktree controls when git worktrees are ready', () => {
    const state = {
      loading: false,
      error: null,
      status: {
        projectPath: '/project',
        isGitRepo: true,
        hasHead: true,
        canUseWorktrees: true,
      },
    };

    expect(getWorktreeGitBlockingMessage(state, true)).toBeNull();
    expect(getWorktreeGitControlDisabledReason(state)).toBeNull();
  });
});
