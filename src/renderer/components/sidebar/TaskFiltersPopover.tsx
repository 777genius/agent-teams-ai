import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Combobox } from '@renderer/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Filter } from 'lucide-react';

import {
  type ReadFilter,
  STATUS_OPTIONS,
  type TaskFiltersState,
  type TaskStatusFilterId,
} from './taskFiltersState';

import type { ComboboxOption } from '../ui/combobox';

const READ_FILTER_OPTIONS: { value: ReadFilter; labelKey: 'all' | 'unread' | 'read' }[] = [
  { value: 'all', labelKey: 'all' },
  { value: 'unread', labelKey: 'unread' },
  { value: 'read', labelKey: 'read' },
];

interface TaskFiltersPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: { teamName: string; displayName: string }[];
  projectOptions: ComboboxOption[];
  filters: TaskFiltersState;
  onFiltersChange: (f: TaskFiltersState) => void;
  onApply: () => void;
}

export const TaskFiltersPopover = ({
  open,
  onOpenChange,
  teams,
  projectOptions,
  filters,
  onFiltersChange,
  onApply,
}: TaskFiltersPopoverProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  // Draft state — all changes accumulate here and only commit on Apply
  const [draft, setDraft] = useState<TaskFiltersState>(filters);

  // Reset draft when popover opens
  useEffect(() => {
    if (open) {
      setDraft(filters);
    }
  }, [open, filters]);

  const allSelected =
    open && STATUS_OPTIONS.length > 0 && STATUS_OPTIONS.every((opt) => draft.statusIds.has(opt.id));

  const handleSelectAll = (): void => {
    if (allSelected) {
      setDraft({ ...draft, statusIds: new Set() });
    } else {
      setDraft({
        ...draft,
        statusIds: new Set(STATUS_OPTIONS.map((o) => o.id)),
      });
    }
  };

  const toggleStatus = (id: TaskStatusFilterId): void => {
    const next = new Set(draft.statusIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraft({ ...draft, statusIds: next });
  };

  const handleApply = (): void => {
    onFiltersChange(draft);
    onApply();
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center justify-center rounded p-0.5 text-text-muted transition-colors hover:text-text-secondary data-[state=open]:bg-surface-raised data-[state=open]:text-text"
        >
          <Filter className="size-3.5" />
        </button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent className="w-64 p-3" align="end" sideOffset={6}>
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-text-secondary">
                  {t('taskFilters.status')}
                </span>
                <button
                  type="button"
                  className="text-[10px] text-text-muted hover:text-text-secondary"
                  onClick={handleSelectAll}
                >
                  {allSelected ? t('taskFilters.clearAll') : t('taskFilters.selectAll')}
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {STATUS_OPTIONS.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex cursor-pointer items-center gap-2 text-[12px] text-text"
                  >
                    <Checkbox
                      checked={draft.statusIds.has(opt.id)}
                      onCheckedChange={() => toggleStatus(opt.id)}
                      style={{ '--color-accent': opt.color } as React.CSSProperties}
                    />
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: opt.color }}
                    />
                    {t(`taskFilters.statusOptions.${opt.labelKey}`)}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] font-semibold text-text-secondary">
                {t('taskFilters.team')}
              </span>
              <Combobox
                options={[
                  { value: '__all__', label: t('taskFilters.allTeams') },
                  ...teams.map((t) => ({ value: t.teamName, label: t.displayName })),
                ]}
                value={draft.teamName ?? '__all__'}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    teamName: v === '__all__' ? null : v,
                  })
                }
                placeholder={t('taskFilters.allTeams')}
                searchPlaceholder={t('taskFilters.searchTeams')}
                emptyMessage={t('taskFilters.noTeamsFound')}
                className="text-[12px]"
              />
            </div>

            {projectOptions.length > 0 && (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold text-text-secondary">
                  {t('taskFilters.project')}
                </span>
                <Combobox
                  options={projectOptions}
                  value={draft.projectPath ?? ''}
                  onValueChange={(v) => setDraft({ ...draft, projectPath: v || null })}
                  placeholder={t('taskFilters.allProjects')}
                  searchPlaceholder={t('taskFilters.searchProjects')}
                  emptyMessage={t('taskFilters.noProjects')}
                  className="text-[12px]"
                  resetLabel={t('taskFilters.allProjects')}
                  onReset={() => setDraft({ ...draft, projectPath: null })}
                />
              </div>
            )}

            <div>
              <span className="mb-1.5 block text-[11px] font-semibold text-text-secondary">
                {t('taskFilters.comments')}
              </span>
              <div className="flex rounded-md border border-[var(--color-border)]">
                {READ_FILTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`flex-1 px-2 py-1 text-[11px] font-medium transition-colors first:rounded-l-[5px] last:rounded-r-[5px] ${
                      draft.readFilter === opt.value
                        ? 'bg-[var(--color-surface-raised)] text-text'
                        : 'text-text-muted hover:text-text-secondary'
                    }`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        readFilter: opt.value,
                        unreadOnly: opt.value === 'unread',
                      })
                    }
                  >
                    {t(`taskFilters.read.${opt.labelKey}`)}
                  </button>
                ))}
              </div>
            </div>

            <Button
              type="button"
              variant="default"
              size="sm"
              className="w-full"
              onClick={handleApply}
            >
              {t('taskFilters.apply')}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
};
