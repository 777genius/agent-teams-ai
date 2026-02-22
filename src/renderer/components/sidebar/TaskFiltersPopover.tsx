import { useSyncExternalStore } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Combobox } from '@renderer/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';
import { Filter } from 'lucide-react';

export type TaskStatusFilterId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

const STATUS_OPTIONS: { id: TaskStatusFilterId; label: string }[] = [
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
  { id: 'review', label: 'REVIEW' },
  { id: 'approved', label: 'APPROVED' },
];

export interface TaskFiltersState {
  statusIds: Set<TaskStatusFilterId>;
  teamName: string | null;
  unreadOnly: boolean;
}

interface TaskFiltersPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: { teamName: string; displayName: string }[];
  filters: TaskFiltersState;
  onFiltersChange: (f: TaskFiltersState) => void;
  onApply: () => void;
}

export const TaskFiltersPopover = ({
  open,
  onOpenChange,
  teams,
  filters,
  onFiltersChange,
  onApply,
}: TaskFiltersPopoverProps): React.JSX.Element => {
  const allSelected =
    STATUS_OPTIONS.length > 0 && STATUS_OPTIONS.every((opt) => filters.statusIds.has(opt.id));

  const handleSelectAll = (): void => {
    if (allSelected) {
      onFiltersChange({ ...filters, statusIds: new Set() });
    } else {
      onFiltersChange({
        ...filters,
        statusIds: new Set(STATUS_OPTIONS.map((o) => o.id)),
      });
    }
  };

  const toggleStatus = (id: TaskStatusFilterId): void => {
    const next = new Set(filters.statusIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onFiltersChange({ ...filters, statusIds: next });
  };

  const handleApply = (): void => {
    onApply();
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text-secondary data-[state=open]:bg-surface-raised data-[state=open]:text-text"
        >
          <Filter className="size-3" />
          Filters
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end" sideOffset={6}>
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-text-secondary">Status</span>
              <button
                type="button"
                className="text-[10px] text-text-muted hover:text-text-secondary"
                onClick={handleSelectAll}
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {STATUS_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className="flex cursor-pointer items-center gap-2 text-[12px] text-text"
                >
                  <Checkbox
                    checked={filters.statusIds.has(opt.id)}
                    onCheckedChange={() => toggleStatus(opt.id)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold text-text-secondary">Team</span>
            <Combobox
              options={[
                { value: '__all__', label: 'All teams' },
                ...teams.map((t) => ({ value: t.teamName, label: t.displayName })),
              ]}
              value={filters.teamName ?? '__all__'}
              onValueChange={(v) =>
                onFiltersChange({
                  ...filters,
                  teamName: v === '__all__' ? null : v,
                })
              }
              placeholder="All teams"
              searchPlaceholder="Search teams..."
              emptyMessage="No teams found"
              className="text-[12px]"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text">
            <Checkbox
              checked={filters.unreadOnly}
              onCheckedChange={(checked) =>
                onFiltersChange({ ...filters, unreadOnly: checked === true })
              }
            />
            Tasks with unread comments
          </label>

          <Button
            type="button"
            variant="default"
            size="sm"
            className="w-full"
            onClick={handleApply}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export const defaultTaskFiltersState = (): TaskFiltersState => ({
  statusIds: new Set(STATUS_OPTIONS.map((o) => o.id)),
  teamName: null,
  unreadOnly: false,
});

export function taskMatchesStatus(
  task: { status: string; kanbanColumn?: 'review' | 'approved' },
  statusIds: Set<TaskStatusFilterId>
): boolean {
  if (statusIds.size === 0) return false;
  if (statusIds.size === STATUS_OPTIONS.length) return true;

  const inTodo = task.status === 'pending' && !task.kanbanColumn;
  const inProgress = task.status === 'in_progress';
  const inDone = task.status === 'completed' && !task.kanbanColumn;
  const inReview = task.kanbanColumn === 'review';
  const inApproved = task.kanbanColumn === 'approved';

  return (
    (statusIds.has('todo') && inTodo) ||
    (statusIds.has('in_progress') && inProgress) ||
    (statusIds.has('done') && inDone) ||
    (statusIds.has('review') && inReview) ||
    (statusIds.has('approved') && inApproved)
  );
}

export function useReadStateSnapshot(): ReturnType<typeof getSnapshot> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getTaskUnreadCount(
  readState: ReturnType<typeof getSnapshot>,
  teamName: string,
  taskId: string,
  comments: { createdAt: string }[] | undefined
): number {
  return getUnreadCount(readState, teamName, taskId, comments ?? []);
}
