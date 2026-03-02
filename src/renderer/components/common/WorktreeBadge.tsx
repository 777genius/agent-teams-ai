/**
 * WorktreeBadge - Displays a compact badge indicating the worktree source.
 * Shows subtle, muted colors for each worktree type.
 */

import { WORKTREE_BADGE_BG, WORKTREE_BADGE_TEXT } from '@renderer/constants/cssVariables';

import type { WorktreeSource } from '@renderer/types/data';

interface WorktreeBadgeProps {
  source: WorktreeSource;
  /** Whether this is the main worktree */
  isMain?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Configuration for each worktree source type.
 * Uses muted, subtle colors to avoid being too flashy.
 */
interface SourceConfig {
  label: string;
  bgColor: string;
  textColor: string;
}

// Muted color palette - all using zinc/neutral tones with subtle tints
const SOURCE_CONFIG: Record<WorktreeSource, SourceConfig> = {
  'vibe-kanban': {
    label: 'Vibe',
    bgColor: WORKTREE_BADGE_BG, // zinc-400
    textColor: WORKTREE_BADGE_TEXT, // zinc-400
  },
  conductor: {
    label: 'Conductor',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  'auto-claude': {
    label: 'Auto',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  '21st': {
    label: '21st',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  'claude-desktop': {
    label: 'Desktop',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  'claude-code': {
    label: 'Worktree',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  ccswitch: {
    label: 'ccswitch',
    bgColor: WORKTREE_BADGE_BG,
    textColor: WORKTREE_BADGE_TEXT,
  },
  git: {
    label: '',
    bgColor: 'transparent',
    textColor: 'transparent',
  },
  unknown: {
    label: '',
    bgColor: 'transparent',
    textColor: 'transparent',
  },
};

// Default worktree badge config (not "Main" to avoid confusion with main branch)
const DEFAULT_CONFIG: SourceConfig = {
  label: 'Default',
  bgColor: 'rgba(82, 82, 91, 0.3)', // zinc-600
  textColor: '#71717a', // zinc-500
};

export const WorktreeBadge = ({
  source,
  isMain = false,
  className = '',
}: Readonly<WorktreeBadgeProps>): React.ReactElement | null => {
  // Show Default badge if isMain is true (the default/primary worktree)
  if (isMain) {
    return (
      <span
        className={`inline-flex shrink-0 items-center rounded px-1 py-px text-[9px] font-medium ${className}`}
        style={{
          backgroundColor: DEFAULT_CONFIG.bgColor,
          color: DEFAULT_CONFIG.textColor,
        }}
      >
        {DEFAULT_CONFIG.label}
      </span>
    );
  }

  const config = SOURCE_CONFIG[source];

  // Don't render badge for standard git or unknown sources
  if (source === 'git' || source === 'unknown' || !config.label) {
    return null;
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1 py-px text-[9px] font-medium ${className}`}
      style={{
        backgroundColor: config.bgColor,
        color: config.textColor,
      }}
      title={`Created by ${config.label}`}
    >
      {config.label}
    </span>
  );
};
