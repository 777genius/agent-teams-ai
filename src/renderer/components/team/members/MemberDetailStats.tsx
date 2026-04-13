import { formatRelativeTime, formatTokensCompact } from '@renderer/utils/formatters';

import type { MemberDetailTab } from './memberDetailTypes';

interface MemberDetailStatsProps {
  totalTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  activityCount: number;
  totalTokens: number | null;
  statsLoading?: boolean;
  statsComputedAt?: string;
  onTabChange?: (tab: MemberDetailTab) => void;
}

const baseClasses =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5';
const clickableClasses =
  'cursor-pointer transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-overlay)]';

const StatBlock = ({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  onClick?: () => void;
}): React.JSX.Element => {
  const classes = onClick ? `${baseClasses} ${clickableClasses}` : baseClasses;
  const content = (
    <>
      <p className="text-base font-semibold leading-tight text-[var(--color-text)]">{value}</p>
      <p className="text-[10px] text-[var(--color-text-muted)]">{label}</p>
      {sub && <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">{sub}</p>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={classes}>{content}</div>;
};

export const MemberDetailStats = ({
  totalTasks,
  inProgressTasks,
  completedTasks,
  activityCount,
  totalTokens,
  statsLoading,
  statsComputedAt,
  onTabChange,
}: MemberDetailStatsProps): React.JSX.Element => {
  const tokensValue = statsLoading
    ? '...'
    : totalTokens != null
      ? formatTokensCompact(totalTokens)
      : '—';
  const tokensSub =
    !statsLoading && statsComputedAt ? `updated ${formatRelativeTime(statsComputedAt)}` : undefined;

  return (
    <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5">
      <StatBlock
        label="Tasks"
        value={totalTasks}
        sub={inProgressTasks > 0 ? `in progress: ${inProgressTasks}` : undefined}
        onClick={onTabChange ? () => onTabChange('tasks') : undefined}
      />
      <StatBlock
        label="Completed"
        value={completedTasks}
        onClick={onTabChange ? () => onTabChange('tasks') : undefined}
      />
      <StatBlock
        label="Activity"
        value={activityCount}
        onClick={onTabChange ? () => onTabChange('activity') : undefined}
      />
      <StatBlock
        label="Tokens"
        value={tokensValue}
        sub={tokensSub}
        onClick={onTabChange ? () => onTabChange('stats') : undefined}
      />
    </div>
  );
};
