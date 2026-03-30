import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { formatSessionLabel } from '@renderer/utils/sessionTitleParser';
import { Crown, Filter } from 'lucide-react';

import type { Session } from '@renderer/types/data';
import type { KanbanColumnId, ResolvedTeamMember } from '@shared/types';

export const UNASSIGNED_OWNER = '__unassigned__';

export interface KanbanFilterState {
  sessionId: string | null;
  selectedOwners: Set<string>;
  /** When non-empty, only these columns are visible on the kanban board. Empty = all columns. */
  columns: Set<KanbanColumnId>;
}

/** Column definitions with display labels and accent colors for filter UI. */
export const KANBAN_COLUMNS: { id: KanbanColumnId; label: string; color: string }[] = [
  { id: 'todo', label: 'TODO', color: 'rgb(59, 130, 246)' },
  { id: 'in_progress', label: 'IN PROGRESS', color: 'rgb(234, 179, 8)' },
  { id: 'done', label: 'DONE', color: 'rgb(34, 197, 94)' },
  { id: 'review', label: 'REVIEW', color: 'rgb(139, 92, 246)' },
  { id: 'approved', label: 'APPROVED', color: 'rgb(22, 163, 74)' },
];

interface KanbanFilterPopoverProps {
  filter: KanbanFilterState;
  sessions: Session[];
  leadSessionId?: string;
  members: ResolvedTeamMember[];
  onFilterChange: (filter: KanbanFilterState) => void;
}

export const KanbanFilterPopover = ({
  filter,
  sessions,
  leadSessionId,
  members,
  onFilterChange,
}: KanbanFilterPopoverProps): React.JSX.Element => {
  const activeCount = useMemo(() => {
    let count = 0;
    if (filter.sessionId !== null) count += 1;
    if (filter.selectedOwners.size > 0) count += 1;
    if (filter.columns.size > 0) count += 1;
    return count;
  }, [filter.sessionId, filter.selectedOwners, filter.columns]);

  const handleSessionSelect = (sessionId: string | null): void => {
    onFilterChange({ ...filter, sessionId });
  };

  const handleOwnerToggle = (ownerKey: string): void => {
    const next = new Set(filter.selectedOwners);
    if (next.has(ownerKey)) {
      next.delete(ownerKey);
    } else {
      next.add(ownerKey);
    }
    onFilterChange({ ...filter, selectedOwners: next });
  };

  const handleColumnToggle = (columnId: KanbanColumnId): void => {
    const next = new Set(filter.columns);
    if (next.has(columnId)) {
      next.delete(columnId);
    } else {
      next.add(columnId);
    }
    onFilterChange({ ...filter, columns: next });
  };

  const handleClearAll = (): void => {
    onFilterChange({ sessionId: null, selectedOwners: new Set(), columns: new Set() });
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-7 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label="Filter tasks"
            >
              <Filter size={14} />
              {activeCount > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-medium text-white">
                  {activeCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Filter tasks</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        {/* Session section */}
        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Session
          </p>
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            <button
              type="button"
              className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                filter.sessionId === null
                  ? 'bg-blue-500/15 text-blue-300'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
              }`}
              onClick={() => handleSessionSelect(null)}
            >
              All sessions
            </button>
            {sessions.map((session) => {
              const isLead = session.id === leadSessionId;
              const isSelected = filter.sessionId === session.id;
              const label = formatSessionLabel(session.firstMessage) || session.id.slice(0, 8);
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                  }`}
                  onClick={() => handleSessionSelect(isSelected ? null : session.id)}
                >
                  {isLead && <Crown size={11} className="shrink-0 text-blue-400" />}
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Teammate section */}
        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Teammate
          </p>
          <div className="space-y-1.5">
            {members.map((member) => (
              <label
                key={member.name}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
              >
                <Checkbox
                  checked={filter.selectedOwners.has(member.name)}
                  onCheckedChange={() => handleOwnerToggle(member.name)}
                />
                {displayMemberName(member.name)}
              </label>
            ))}
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radix Checkbox renders a button, not a native input */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs italic text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox
                checked={filter.selectedOwners.has(UNASSIGNED_OWNER)}
                onCheckedChange={() => handleOwnerToggle(UNASSIGNED_OWNER)}
              />
              (unassigned)
            </label>
          </div>
        </div>

        {/* Column section */}
        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Column
          </p>
          <div className="space-y-1.5">
            {KANBAN_COLUMNS.map((col) => (
              <label
                key={col.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-[var(--color-surface-raised)]"
                style={{ color: col.color }}
              >
                <Checkbox
                  checked={filter.columns.has(col.id)}
                  onCheckedChange={() => handleColumnToggle(col.id)}
                />
                {col.label}
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            disabled={activeCount === 0}
            onClick={handleClearAll}
          >
            Clear all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
