import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { ArrowUpDown, Check } from 'lucide-react';

import { type TaskViewSortMode } from './taskViewPolicy';

const SHARED_SORT_OPTIONS = [
  { id: 'time', labelKey: 'tasksPanel.sort.byTime' },
  { id: 'unread', labelKey: 'tasksPanel.sort.byUnread' },
  { id: 'project', labelKey: 'tasksPanel.sort.byProject' },
  { id: 'team', labelKey: 'tasksPanel.sort.byTeam' },
] as const;

export const TREE_MANUAL_SORT_OPTION = {
  id: 'manual',
  labelKey: 'tasksPanel.sort.manualOrder',
} as const;

export const TaskSortPopover = ({
  open,
  onOpenChange,
  mode,
  onModeChange,
  includeManual = false,
  testId = 'task-view-sort',
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  mode: TaskViewSortMode;
  onModeChange(mode: TaskViewSortMode): void;
  includeManual?: boolean;
  testId?: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const options = includeManual
    ? [TREE_MANUAL_SORT_OPTION, ...SHARED_SORT_OPTIONS]
    : SHARED_SORT_OPTIONS;
  const activeOption = options.find((option) => option.id === mode) ?? options[0];
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-text-muted"
          aria-label={t(activeOption.labelKey)}
          data-testid={testId}
        >
          <ArrowUpDown className="size-3" />
          <span className="max-w-20 truncate">{t(activeOption.labelKey)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-36 p-1"
        align="end"
        sideOffset={6}
        data-testid={`${testId}-content`}
        // Stray programmatic focus from the folders tree must not dismiss the popover.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="flex flex-col">
          {options.map((option) => (
            <Button
              key={option.id}
              type="button"
              data-sort-option={option.id}
              variant="ghost"
              size="sm"
              onClick={() => {
                onModeChange(option.id);
                onOpenChange(false);
              }}
              className={`h-auto w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] ${
                mode === option.id
                  ? 'bg-surface-raised text-text'
                  : 'hover:bg-surface-raised/60 text-text-secondary hover:text-text'
              }`}
            >
              <Check
                className={`size-3 shrink-0 ${mode === option.id ? 'opacity-100' : 'opacity-0'}`}
              />
              {t(option.labelKey)}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
