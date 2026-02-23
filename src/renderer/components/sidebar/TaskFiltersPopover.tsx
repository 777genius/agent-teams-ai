import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Combobox } from '@renderer/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Filter } from 'lucide-react';

import { STATUS_OPTIONS, type TaskFiltersState, type TaskStatusFilterId } from './taskFiltersState';

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

          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Checkbox is a custom component wrapping native input */}
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
