import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Crown, Filter } from 'lucide-react';

import type { Session } from '@renderer/types/data';
import type { ResolvedTeamMember } from '@shared/types';

export const UNASSIGNED_OWNER = '__unassigned__';

export interface KanbanFilterState {
  sessionId: string | null;
  selectedOwners: Set<string>;
}

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
    return count;
  }, [filter.sessionId, filter.selectedOwners]);

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

  const handleClearAll = (): void => {
    onFilterChange({ sessionId: null, selectedOwners: new Set() });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-7 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label="Filter tasks"
          title="Filter"
        >
          <Filter size={14} />
          {activeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-medium text-white">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
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
              const label = session.firstMessage?.slice(0, 50) ?? session.id.slice(0, 8);
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
                {member.name}
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
