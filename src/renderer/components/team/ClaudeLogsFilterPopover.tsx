import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Filter } from 'lucide-react';

export type ClaudeLogStream = 'stdout' | 'stderr';
export type ClaudeLogKind = 'output' | 'thinking' | 'tool';

export interface ClaudeLogsFilterState {
  streams: Set<ClaudeLogStream>;
  kinds: Set<ClaudeLogKind>;
}

export const DEFAULT_CLAUDE_LOGS_FILTER: ClaudeLogsFilterState = {
  streams: new Set<ClaudeLogStream>(['stdout', 'stderr']),
  kinds: new Set<ClaudeLogKind>(['output', 'thinking', 'tool']),
};

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function getActiveCount(filter: ClaudeLogsFilterState): number {
  let count = 0;
  if (!setEquals(filter.streams, DEFAULT_CLAUDE_LOGS_FILTER.streams)) count += 1;
  if (!setEquals(filter.kinds, DEFAULT_CLAUDE_LOGS_FILTER.kinds)) count += 1;
  return count;
}

interface ClaudeLogsFilterPopoverProps {
  filter: ClaudeLogsFilterState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (filter: ClaudeLogsFilterState) => void;
}

export const ClaudeLogsFilterPopover = ({
  filter,
  open,
  onOpenChange,
  onApply,
}: ClaudeLogsFilterPopoverProps): React.JSX.Element => {
  const [draft, setDraft] = useState<ClaudeLogsFilterState>(() => ({
    streams: new Set(filter.streams),
    kinds: new Set(filter.kinds),
  }));

  useEffect(() => {
    if (!open) return;
    const next = { streams: new Set(filter.streams), kinds: new Set(filter.kinds) };
    queueMicrotask(() => setDraft(next));
  }, [open, filter.streams, filter.kinds]);

  const activeCount = useMemo(() => getActiveCount(filter), [filter]);
  const draftCount = useMemo(() => getActiveCount(draft), [draft]);

  const toggleStream = (stream: ClaudeLogStream): void => {
    setDraft((prev) => {
      const next = new Set(prev.streams);
      if (next.has(stream)) next.delete(stream);
      else next.add(stream);
      // Prevent empty selection (keep at least one)
      if (next.size === 0) {
        next.add(stream);
      }
      return { ...prev, streams: next };
    });
  };

  const toggleKind = (kind: ClaudeLogKind): void => {
    setDraft((prev) => {
      const next = new Set(prev.kinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      // Prevent empty selection (keep at least one)
      if (next.size === 0) {
        next.add(kind);
      }
      return { ...prev, kinds: next };
    });
  };

  const handleSave = (): void => {
    onApply(draft);
    onOpenChange(false);
  };

  const handleReset = (): void => {
    const empty = {
      streams: new Set(DEFAULT_CLAUDE_LOGS_FILTER.streams),
      kinds: new Set(DEFAULT_CLAUDE_LOGS_FILTER.kinds),
    };
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
              aria-label="Filter Claude logs"
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
        <TooltipContent side="bottom">Filter logs</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Stream
          </p>
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox checked={draft.streams.has('stdout')} onCheckedChange={() => toggleStream('stdout')} />
              stdout
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox checked={draft.streams.has('stderr')} onCheckedChange={() => toggleStream('stderr')} />
              stderr
            </label>
          </div>
        </div>

        <div className="border-b border-[var(--color-border)] p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Content
          </p>
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox checked={draft.kinds.has('output')} onCheckedChange={() => toggleKind('output')} />
              Output
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox checked={draft.kinds.has('thinking')} onCheckedChange={() => toggleKind('thinking')} />
              Thinking
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]">
              <Checkbox checked={draft.kinds.has('tool')} onCheckedChange={() => toggleKind('tool')} />
              Tool calls
            </label>
          </div>
        </div>

        <div className="flex justify-between gap-2 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            disabled={draftCount === 0}
            onClick={handleReset}
          >
            Reset
          </Button>
          <Button size="sm" className="h-7 px-3 text-[11px]" onClick={handleSave}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

