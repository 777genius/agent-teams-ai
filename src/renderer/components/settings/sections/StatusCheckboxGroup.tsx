import type { useAppTranslation } from '@features/localization/renderer';
import type { TeamReviewState, TeamTaskStatus } from '@shared/types';

/** Notification targets span workflow status plus the explicit review axis. */
type NotifiableStatus =
  | TeamTaskStatus
  | Extract<TeamReviewState, 'review' | 'needsFix' | 'approved'>;

const STATUS_OPTIONS = [
  {
    value: 'in_progress',
    labelKey: 'notifications.team.statusChange.statuses.options.in_progress',
  },
  { value: 'completed', labelKey: 'notifications.team.statusChange.statuses.options.completed' },
  { value: 'review', labelKey: 'notifications.team.statusChange.statuses.options.review' },
  { value: 'needsFix', labelKey: 'notifications.team.statusChange.statuses.options.needsFix' },
  { value: 'approved', labelKey: 'notifications.team.statusChange.statuses.options.approved' },
  { value: 'pending', labelKey: 'notifications.team.statusChange.statuses.options.pending' },
  { value: 'deleted', labelKey: 'notifications.team.statusChange.statuses.options.deleted' },
] as const satisfies readonly { value: NotifiableStatus; labelKey: string }[];

export const StatusCheckboxGroup = ({
  selected,
  onChange,
  disabled,
  t,
}: {
  selected: string[];
  onChange: (statuses: string[]) => void;
  disabled: boolean;
  t: ReturnType<typeof useAppTranslation>['t'];
}) => (
  <div className="flex flex-wrap gap-2">
    {STATUS_OPTIONS.map((option) => {
      const checked = selected.includes(option.value);
      return (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = checked
              ? selected.filter((selectedStatus) => selectedStatus !== option.value)
              : [...selected, option.value];
            onChange(next);
          }}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            checked
              ? 'bg-indigo-500/20 text-indigo-400'
              : 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {t(option.labelKey)}
        </button>
      );
    })}
  </div>
);
