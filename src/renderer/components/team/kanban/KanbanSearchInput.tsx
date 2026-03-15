import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { TASK_STATUS_LABELS } from '@renderer/utils/memberHelpers';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';
import { formatDistanceToNowStrict } from 'date-fns';
import { Hash, Search, X } from 'lucide-react';

import type { ResolvedTeamMember, TeamTask } from '@shared/types';

interface KanbanSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  tasks: TeamTask[];
  members: ResolvedTeamMember[];
}

const MAX_SUGGESTIONS = 15;

/**
 * Kanban search input with task autocomplete dropdown.
 * When user types `#`, shows a filterable list of tasks by displayId.
 * Selecting a task inserts `#<displayId>` into the search field.
 */
export const KanbanSearchInput = ({
  value,
  onChange,
  tasks,
  members,
}: KanbanSearchInputProps): React.JSX.Element => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Prevents the useEffect from reopening the dropdown right after a selection. */
  const suppressReopenRef = useRef(false);

  // Detect `#` trigger and extract filter text after it
  const hashMatch = useMemo(() => {
    const match = value.match(/#(\S*)$/);
    return match ? match[1] : null;
  }, [value]);

  const isHashMode = hashMatch !== null;

  // Filter tasks by displayId when in hash mode
  const suggestions = useMemo(() => {
    if (!isHashMode) return [];
    const filter = hashMatch.toLowerCase();
    const filtered = tasks.filter((t) => {
      const displayId = getTaskDisplayId(t).toLowerCase();
      return filter === '' || displayId.includes(filter);
    });
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [isHashMode, hashMatch, tasks]);

  // Show dropdown when in hash mode with suggestions
  useEffect(() => {
    if (suppressReopenRef.current) {
      suppressReopenRef.current = false;
      return;
    }
    if (isHashMode && suggestions.length > 0) {
      setShowDropdown(true);
      setActiveIndex(0);
    } else {
      setShowDropdown(false);
    }
  }, [isHashMode, suggestions.length]);

  // Close on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  // Scroll active item into view
  useEffect(() => {
    if (!showDropdown || !listRef.current) return;
    const activeEl = listRef.current.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showDropdown]);

  const selectTask = useCallback(
    (task: TeamTask) => {
      const displayId = getTaskDisplayId(task);
      // Replace the `#<partial>` at end of input with the full `#<displayId>`
      const newValue = value.replace(/#\S*$/, `#${displayId}`);
      suppressReopenRef.current = true;
      onChange(newValue);
      setShowDropdown(false);
      inputRef.current?.focus();
    },
    [value, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown || suggestions.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectTask(suggestions[activeIndex]);
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
      }
    },
    [showDropdown, suggestions, activeIndex, selectTask]
  );

  return (
    <div ref={containerRef} className="relative max-w-[240px]">
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
      />
      <input
        ref={inputRef}
        type="text"
        placeholder="Search tasks... (#id or text)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-8 w-full min-w-[140px] max-w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-8 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
      />
      {value && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => onChange('')}
            >
              <X size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear search</TooltipContent>
        </Tooltip>
      )}

      {/* Autocomplete dropdown */}
      {showDropdown && suggestions.length > 0 && (
        <div
          ref={listRef}
          className="absolute left-0 top-full z-50 mt-1 max-h-[280px] w-[360px] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] py-1 shadow-xl shadow-black/30"
        >
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <Hash size={10} className="text-[var(--color-text-muted)]" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Tasks
            </span>
          </div>
          {suggestions.map((task, index) => (
            <TaskSuggestionItem
              key={task.id}
              task={task}
              index={index}
              members={members}
              isActive={index === activeIndex}
              onSelect={() => selectTask(task)}
              onHover={() => setActiveIndex(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Individual task suggestion row
// ---------------------------------------------------------------------------

interface TaskSuggestionItemProps {
  task: TeamTask;
  index: number;
  members: ResolvedTeamMember[];
  isActive: boolean;
  onSelect: () => void;
  onHover: () => void;
}

const TaskSuggestionItem = React.memo(function TaskSuggestionItem({
  task,
  index,
  members,
  isActive,
  onSelect,
  onHover,
}: TaskSuggestionItemProps): React.JSX.Element {
  const displayId = getTaskDisplayId(task);
  const statusLabel = TASK_STATUS_LABELS[task.status] ?? task.status;
  const memberColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (m.color) map.set(m.name, m.color);
    }
    return map;
  }, [members]);

  const createdAgo = useMemo(() => {
    if (!task.createdAt) return null;
    const date = new Date(task.createdAt);
    return isNaN(date.getTime()) ? null : formatDistanceToNowStrict(date, { addSuffix: true });
  }, [task.createdAt]);

  const updatedAgo = useMemo(() => {
    if (!task.updatedAt) return null;
    const date = new Date(task.updatedAt);
    return isNaN(date.getTime()) ? null : formatDistanceToNowStrict(date, { addSuffix: true });
  }, [task.updatedAt]);

  const statusStyle = useMemo(() => {
    switch (task.status) {
      case 'pending':
        return 'bg-zinc-500/15 text-zinc-400';
      case 'in_progress':
        return 'bg-blue-500/15 text-blue-400';
      case 'completed':
        return 'bg-emerald-500/15 text-emerald-400';
      case 'deleted':
        return 'bg-red-500/15 text-red-400';
      default:
        return 'bg-zinc-500/15 text-zinc-400';
    }
  }, [task.status]);

  const zebraBg = index % 2 === 1 ? 'var(--card-bg-zebra)' : 'var(--card-bg)';

  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:!bg-[var(--color-surface-raised)]"
      style={{
        backgroundColor: isActive ? 'var(--color-surface-raised)' : zebraBg,
      }}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {/* Left column: ID + status */}
      <div className="flex shrink-0 flex-col items-start gap-0.5">
        <span className="font-mono text-[11px] font-medium text-[var(--color-text)]">
          #{displayId}
        </span>
        <span className={`rounded px-1 py-px text-[9px] font-medium ${statusStyle}`}>
          {statusLabel}
        </span>
      </div>
      {/* Right column: subject + metadata */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] text-[var(--color-text-secondary)]">{task.subject}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {task.createdBy && (
            <MemberBadge
              name={task.createdBy}
              color={memberColorMap.get(task.createdBy)}
              size="xs"
              hideAvatar
            />
          )}
          {createdAgo && (
            <span className="text-[9px] text-[var(--color-text-muted)]">created {createdAgo}</span>
          )}
          {updatedAgo && updatedAgo !== createdAgo && (
            <span className="text-[9px] text-[var(--color-text-muted)]">updated {updatedAgo}</span>
          )}
        </div>
      </div>
    </button>
  );
});
