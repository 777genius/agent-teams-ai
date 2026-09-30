import {
  getWorktreeGitBlockingMessage,
  getWorktreeGitControlDisabledReason,
} from '@renderer/components/team/dialogs/WorktreeGitReadinessBanner';
import { describe, expect, it } from 'vitest';

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

  it('preserves loading, error, and missing-status helper precedence', () => {
    const loadingState = {
      loading: true,
      error: 'stale error',
      status: null,
    };
    expect(getWorktreeGitBlockingMessage(loadingState, true)).toBe(
      'Checking Git repository status before enabling worktree isolation.'
    );
    expect(getWorktreeGitControlDisabledReason(loadingState)).toBe(
      'Checking Git repository status...'
    );

    const errorState = {
      loading: false,
      error: 'Git inspection failed',
      status: null,
    };
    expect(getWorktreeGitBlockingMessage(errorState, true)).toBe('Git inspection failed');
    expect(getWorktreeGitControlDisabledReason(errorState)).toBe('Git inspection failed');

    const missingState = {
      loading: false,
      error: null,
      status: null,
    };
    expect(getWorktreeGitBlockingMessage(missingState, true)).toBe(
      'Worktree isolation requires a Git repository with an initial commit.'
    );
    expect(getWorktreeGitControlDisabledReason(missingState)).toBeNull();
  });
});
