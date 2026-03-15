import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { ArrowDownUp, ArrowUpDown, Calendar, Clock, GripVertical, User } from 'lucide-react';

export type KanbanSortField = 'updatedAt' | 'createdAt' | 'owner' | 'manual';

export interface KanbanSortState {
  field: KanbanSortField;
}

const SORT_OPTIONS: {
  field: KanbanSortField;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    field: 'updatedAt',
    label: 'Last updated',
    description: 'Recently updated first',
    icon: <Clock size={14} />,
  },
  {
    field: 'createdAt',
    label: 'Created',
    description: 'Newest first',
    icon: <Calendar size={14} />,
  },
  {
    field: 'owner',
    label: 'Owner',
    description: 'Alphabetically by assignee',
    icon: <User size={14} />,
  },
  {
    field: 'manual',
    label: 'Manual',
    description: 'Drag-and-drop order',
    icon: <GripVertical size={14} />,
  },
];

interface KanbanSortPopoverProps {
  sort: KanbanSortState;
  onSortChange: (sort: KanbanSortState) => void;
}

export const KanbanSortPopover = ({
  sort,
  onSortChange,
}: KanbanSortPopoverProps): React.JSX.Element => {
  const isNonDefault = sort.field !== 'updatedAt';

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-7 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label="Sort tasks"
            >
              <ArrowUpDown size={14} />
              {isNonDefault && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-medium text-white">
                  1
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sort tasks</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-56 p-0">
        <div className="p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Sort by
          </p>
          <div className="space-y-0.5">
            {SORT_OPTIONS.map((option) => {
              const isSelected = sort.field === option.field;
              return (
                <button
                  key={option.field}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    isSelected
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                  )}
                  onClick={() => onSortChange({ field: option.field })}
                >
                  <span
                    className={cn(
                      'shrink-0',
                      isSelected ? 'text-blue-400' : 'text-[var(--color-text-muted)]'
                    )}
                  >
                    {option.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">{option.label}</div>
                    <div
                      className={cn(
                        'text-[10px]',
                        isSelected ? 'text-blue-300/70' : 'text-[var(--color-text-muted)]'
                      )}
                    >
                      {option.description}
                    </div>
                  </div>
                  {isSelected && (
                    <ArrowDownUp size={12} className="ml-auto shrink-0 text-blue-400" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {isNonDefault && (
          <div className="flex justify-end border-t border-[var(--color-border)] p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => onSortChange({ field: 'updatedAt' })}
            >
              Reset
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
