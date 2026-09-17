import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';

import { MessagesFilterPopover } from './MessagesFilterPopover';

import type { MessagesFilterState } from './MessagesFilterPopover';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';
import type { JSX } from 'react';

interface MessagesSearchControlsProps {
  teamName: string;
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  filter: MessagesFilterState;
  filterOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  onFilterApply: (filter: MessagesFilterState) => void;
  searchPlaceholder: string;
}

export const MessagesSearchControls = ({
  teamName,
  members,
  messages,
  searchQuery,
  onSearchQueryChange,
  filter,
  filterOpen,
  onFilterOpenChange,
  onFilterApply,
  searchPlaceholder,
}: MessagesSearchControlsProps): JSX.Element => {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
        />
        {searchQuery ? (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={() => onSearchQueryChange('')}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      <MessagesFilterPopover
        teamName={teamName}
        members={members}
        filter={filter}
        messages={messages}
        open={filterOpen}
        onOpenChange={onFilterOpenChange}
        onApply={onFilterApply}
      />
    </div>
  );
};

interface MessagesSearchBarProps extends MessagesSearchControlsProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  expandLabel: string;
  collapseLabel: string;
}

export const MessagesSearchBar = ({
  collapsed,
  onToggleCollapsed,
  expandLabel,
  collapseLabel,
  ...controls
}: MessagesSearchBarProps): JSX.Element => {
  return (
    <div className="flex items-center gap-2">
      <MessagesSearchControls {...controls} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-events-auto size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapsed();
            }}
          >
            {collapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{collapsed ? expandLabel : collapseLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
};
