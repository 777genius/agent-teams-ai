/**
 * Git status badge for file tree entries.
 *
 * Shows single-letter indicators:
 * - M (modified) — orange
 * - U (untracked) — green
 * - A (staged/added) — green
 * - D (deleted) — red
 * - C (conflict) — red, bold
 * - R (renamed) — cyan
 */

import type { GitFileStatusType } from '@shared/types/editor';

// =============================================================================
// Badge config
// =============================================================================

const STATUS_CONFIG: Record<GitFileStatusType, { letter: string; color: string }> = {
  modified: { letter: 'M', color: 'text-orange-400' },
  untracked: { letter: 'U', color: 'text-green-400' },
  staged: { letter: 'A', color: 'text-green-400' },
  deleted: { letter: 'D', color: 'text-red-400' },
  conflict: { letter: 'C', color: 'text-red-400 font-bold' },
  renamed: { letter: 'R', color: 'text-cyan-400' },
};

// =============================================================================
// Component
// =============================================================================

interface GitStatusBadgeProps {
  status: GitFileStatusType;
}

export const GitStatusBadge = ({ status }: GitStatusBadgeProps): React.ReactElement => {
  const config = STATUS_CONFIG[status];
  return (
    <span className={`ml-auto shrink-0 text-[10px] leading-none ${config.color}`} title={status}>
      {config.letter}
    </span>
  );
};
