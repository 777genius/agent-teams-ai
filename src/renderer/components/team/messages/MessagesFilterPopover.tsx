import { useEffect, useMemo, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { Filter } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export interface MessagesFilterState {
  from: Set<string>;
  to: Set<string>;
  /** When true, include internal coordination noise (idle/shutdown/etc.) */
  showNoise: boolean;
}

interface MessagesFilterPopoverProps {
  teamName: string;
  members: ResolvedTeamMember[];
  filter: MessagesFilterState;
  messages: InboxMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (filter: MessagesFilterState) => void;
}

function collectFromOptions(messages: InboxMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    if (m.from?.trim()) set.add(m.from.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function collectToOptions(messages: InboxMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    if (m.to?.trim()) set.add(m.to.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export const MessagesFilterPopover = ({
  teamName,
  members,
  filter,
  messages,
  open,
  onOpenChange,
  onApply,
}: MessagesFilterPopoverProps): React.JSX.Element => {
  const [draft, setDraft] = useState<MessagesFilterState>({
    from: new Set(),
    to: new Set(),
    showNoise: false,
  });

  useEffect(() => {
    if (open) {
      const next = {
        from: new Set(filter.from),
        to: new Set(filter.to),
        showNoise: !!filter.showNoise,
      };
      const schedule = (): void => setDraft(next);
      queueMicrotask(schedule);
    }
  }, [open, filter.from, filter.to, filter.showNoise]);

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const fromOptions = useMemo(() => collectFromOptions(messages), [messages]);
  const toOptions = useMemo(() => collectToOptions(messages), [messages]);

  const activeCount = (filter.from.size > 0 ? 1 : 0) + (filter.to.size > 0 ? 1 : 0);
  const draftCount = (draft.from.size > 0 ? 1 : 0) + (draft.to.size > 0 ? 1 : 0);

  const toggleFrom = (name: string): void => {
    setDraft((prev) => {
      const next = new Set(prev.from);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...prev, from: next };
    });
  };

  const toggleTo = (name: string): void => {
    setDraft((prev) => {
      const next = new Set(prev.to);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...prev, to: next };
    });
  };

  const handleSave = (): void => {
    onApply(draft);
    onOpenChange(false);
  };

  const handleReset = (): void => {
    const empty = { from: new Set<string>(), to: new Set<string>(), showNoise: false };
    setDraft(empty);
    onApply(empty);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-7 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label="Filter messages"
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
        <TooltipContent side="bottom">Filter messages</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="flex max-h-[70vh] w-72 flex-col p-0">
        {/* Scrollable filter sections */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-[var(--color-border)] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              From
            </p>
            <div className="space-y-1">
              {fromOptions.length === 0 ? (
                <p className="text-xs italic text-[var(--color-text-muted)]">No data</p>
              ) : (
                fromOptions.map((name) => (
                  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps Radix Checkbox which renders native input internally
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
                  >
                    <Checkbox
                      checked={draft.from.has(name)}
                      onCheckedChange={() => toggleFrom(name)}
                    />
                    <MemberBadge
                      name={name}
                      color={colorMap.get(name)}
                      teamName={teamName}
                      size="sm"
                      hideAvatar={name === 'user'}
                    />
                  </label>
                ))
              )}
            </div>
          </div>
          <div className="border-b border-[var(--color-border)] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              To
            </p>
            <div className="space-y-1">
              {toOptions.length === 0 ? (
                <p className="text-xs italic text-[var(--color-text-muted)]">No data</p>
              ) : (
                toOptions.map((name) => (
                  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps Radix Checkbox which renders native input internally
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
                  >
                    <Checkbox checked={draft.to.has(name)} onCheckedChange={() => toggleTo(name)} />
                    <MemberBadge
                      name={name}
                      color={colorMap.get(name)}
                      teamName={teamName}
                      size="sm"
                      hideAvatar={name === 'user'}
                    />
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Fixed bottom section */}
        <div className="shrink-0 border-t border-[var(--color-border)]">
          <div className="border-b border-[var(--color-border)] p-3">
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps Radix Checkbox */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox
                checked={draft.showNoise}
                onCheckedChange={() =>
                  setDraft((prev) => ({ ...prev, showNoise: !prev.showNoise }))
                }
              />
              <span>Show status updates (idle/shutdown)</span>
            </label>
          </div>
          <div className="flex justify-between gap-2 p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              disabled={draftCount === 0 && !draft.showNoise}
              onClick={handleReset}
            >
              Reset
            </Button>
            <Button size="sm" className="h-7 px-3 text-[11px]" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
