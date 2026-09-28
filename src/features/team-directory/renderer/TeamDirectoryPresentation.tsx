import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';

import type { TeamDirectoryRuntime } from '../core/domain/teamDirectory';
import type { ReactNode } from 'react';

export type TeamDirectoryStatus = Exclude<TeamDirectoryRuntime, 'unknown'>;

export interface TeamDirectoryQueryInputProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly label: string;
  readonly className?: string;
}

export const TeamDirectoryQueryInput = ({
  query,
  onQueryChange,
  label,
  className,
}: TeamDirectoryQueryInputProps): React.JSX.Element => {
  return (
    <Input
      aria-label={label}
      placeholder={label}
      value={query}
      onChange={(event) => onQueryChange(event.target.value)}
      className={className}
    />
  );
};

export interface TeamDirectoryStatusFilterProps {
  readonly selectedStatuses: ReadonlySet<TeamDirectoryStatus>;
  readonly onSelectedStatusesChange: (statuses: ReadonlySet<TeamDirectoryStatus>) => void;
  readonly labels: Readonly<Record<TeamDirectoryStatus | 'all', string>>;
  readonly presentation: 'buttons' | 'checkboxes';
  readonly counts?: Partial<Record<TeamDirectoryStatus, number>>;
  readonly className?: string;
  readonly ariaLabel?: string;
}

export const TeamDirectoryStatusFilter = ({
  selectedStatuses,
  onSelectedStatusesChange,
  labels,
  presentation,
  counts,
  className,
  ariaLabel,
}: TeamDirectoryStatusFilterProps): React.JSX.Element => {
  const toggle = (status: TeamDirectoryStatus): void => {
    const next = new Set(selectedStatuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onSelectedStatusesChange(next);
  };
  const statuses: readonly TeamDirectoryStatus[] = ['running', 'offline'];
  if (presentation === 'checkboxes') {
    return (
      <div className={className} role="group" aria-label={ariaLabel}>
        {statuses.map((status) => (
          <label
            key={status}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
          >
            <Checkbox
              checked={selectedStatuses.has(status)}
              onCheckedChange={() => toggle(status)}
            />
            <span>{labels[status]}</span>
            {counts?.[status] !== undefined ? (
              <span className="text-[var(--color-text-muted)]">({counts[status]})</span>
            ) : null}
          </label>
        ))}
      </div>
    );
  }
  return (
    <div className={className} role="group" aria-label={ariaLabel}>
      <Button
        type="button"
        size="sm"
        variant={selectedStatuses.size === 0 ? 'default' : 'outline'}
        aria-pressed={selectedStatuses.size === 0}
        onClick={() => onSelectedStatusesChange(new Set())}
      >
        {labels.all}
      </Button>
      {statuses.map((status) => (
        <Button
          key={status}
          type="button"
          size="sm"
          variant={selectedStatuses.has(status) ? 'default' : 'outline'}
          aria-pressed={selectedStatuses.has(status)}
          onClick={() => toggle(status)}
        >
          {labels[status]}
        </Button>
      ))}
    </div>
  );
};

export interface TeamDirectoryRowHeadingProps {
  readonly displayName: string;
  readonly statusLabel?: string;
  readonly statusTone?: 'danger' | 'muted' | 'success' | 'warning';
  readonly status?: ReactNode;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

const STATUS_CLASSES = {
  danger: 'bg-red-500/15 text-red-300',
  muted: 'bg-zinc-500/15 text-zinc-400',
  success: 'bg-emerald-500/15 text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-300',
} as const;

export const TeamDirectoryRowHeading = ({
  displayName,
  statusLabel,
  statusTone,
  status,
  icon,
  actions,
  className,
}: TeamDirectoryRowHeadingProps): React.JSX.Element => {
  return (
    <div className={className ?? 'flex min-w-0 items-center gap-2.5'}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text)]">
        {displayName}
      </span>
      {status ??
        (statusLabel && statusTone ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[statusTone]}`}
          >
            {statusLabel}
          </span>
        ) : null)}
      {actions}
    </div>
  );
};
