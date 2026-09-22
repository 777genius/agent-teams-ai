/**
 * Worktree Pattern Constants
 *
 * Centralized worktree-related string literals to avoid duplication.
 * These are used in GitIdentityResolver for detecting worktree sources and paths.
 */

// =============================================================================
// Directory Names
// =============================================================================

/** Standard git worktrees subdirectory */
export const WORKTREES_DIR = 'worktrees';

/** Workspaces directory (used by conductor) */
export const WORKSPACES_DIR = 'workspaces';

/** Tasks directory (used by auto-claude) */
export const TASKS_DIR = 'tasks';

// =============================================================================
// Worktree Source Identifiers
// =============================================================================

/** Cursor editor worktrees directory */
export const CURSOR_DIR = '.cursor';

/** Vibe Kanban worktree source */
export const VIBE_KANBAN_DIR = 'vibe-kanban';

/** Conductor worktree source */
export const CONDUCTOR_DIR = 'conductor';

/** Auto-Claude worktree source */
export const AUTO_CLAUDE_DIR = '.auto-claude';

/** 21st/1code worktree source */
export const TWENTYFIRST_DIR = '.21st';

/** Claude Desktop worktrees directory */
export const CLAUDE_WORKTREES_DIR = '.claude-worktrees';

/** ccswitch worktrees directory */
export const CCSWITCH_DIR = '.ccswitch';

/** Claude Code CLI worktrees directory (.claude/worktrees/) */
export const CLAUDE_CODE_DIR = '.claude';
