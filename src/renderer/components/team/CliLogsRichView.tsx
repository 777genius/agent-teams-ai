/**
 * CliLogsRichView
 *
 * Renders CLI stream-json logs using the same rich components as session views:
 * thinking blocks, tool call cards, markdown text output.
 *
 * Replaces raw JSON display in ProvisioningProgressBlock.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DisplayItemList } from '@renderer/components/chat/DisplayItemList';
import { highlightQueryInText } from '@renderer/components/chat/searchHighlightUtils';
import { cn } from '@renderer/lib/utils';
import { parseStreamJsonToGroups } from '@renderer/utils/streamJsonParser';
import { Bot, ChevronRight } from 'lucide-react';

import type { StreamJsonGroup } from '@renderer/utils/streamJsonParser';

interface CliLogsRichViewProps {
  cliLogsTail: string;
  order?: 'oldest-first' | 'newest-first';
  onScroll?: (params: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void;
  containerRefCallback?: (el: HTMLDivElement | null) => void;
  /** Optional local search query override for inline highlighting */
  searchQueryOverride?: string;
  className?: string;
}

/**
 * Derives a scoped Set for a single group from the global prefixed Set.
 * Global keys are stored as `groupId::itemId`; this strips the prefix.
 */
function scopedItemIds(globalIds: Set<string>, groupId: string): Set<string> {
  const prefix = `${groupId}::`;
  const scoped = new Set<string>();
  for (const key of globalIds) {
    if (key.startsWith(prefix)) {
      scoped.add(key.slice(prefix.length));
    }
  }
  return scoped;
}

/**
 * Single-item group rendered flat (no collapsible wrapper).
 */
const FlatGroupItem = ({
  group,
  expandedItemIds,
  onItemClick,
  searchQueryOverride,
}: {
  group: StreamJsonGroup;
  expandedItemIds: Set<string>;
  onItemClick: (itemId: string) => void;
  searchQueryOverride?: string;
}): React.JSX.Element => {
  const groupItemIds = useMemo(
    () => scopedItemIds(expandedItemIds, group.id),
    [expandedItemIds, group.id]
  );
  const handleItemClick = useCallback(
    (itemId: string) => onItemClick(`${group.id}::${itemId}`),
    [group.id, onItemClick]
  );

  return (
    <DisplayItemList
      items={group.items}
      onItemClick={handleItemClick}
      expandedItemIds={groupItemIds}
      aiGroupId={group.id}
      searchQueryOverride={searchQueryOverride}
    />
  );
};

/**
 * A single collapsible group of assistant items (2+ items).
 */
const StreamGroup = ({
  group,
  isExpanded,
  onToggle,
  expandedItemIds,
  onItemClick,
  searchQueryOverride,
}: {
  group: StreamJsonGroup;
  isExpanded: boolean;
  onToggle: () => void;
  expandedItemIds: Set<string>;
  onItemClick: (itemId: string) => void;
  searchQueryOverride?: string;
}): React.JSX.Element => {
  // Scope item IDs to this group to avoid cross-group collisions
  const groupItemIds = useMemo(
    () => scopedItemIds(expandedItemIds, group.id),
    [expandedItemIds, group.id]
  );
  const handleItemClick = useCallback(
    (itemId: string) => onItemClick(`${group.id}::${itemId}`),
    [group.id, onItemClick]
  );

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
        onClick={onToggle}
      >
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-[var(--color-text-muted)] transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        <Bot size={13} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 truncate text-[11px] text-[var(--color-text-secondary)]">
          {searchQueryOverride && searchQueryOverride.trim().length > 0
            ? highlightQueryInText(group.summary, searchQueryOverride, `${group.id}:group-summary`, {
                forceAllActive: true,
              })
            : group.summary}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-[var(--color-border)] p-2">
          <DisplayItemList
            items={group.items}
            onItemClick={handleItemClick}
            expandedItemIds={groupItemIds}
            aiGroupId={group.id}
            searchQueryOverride={searchQueryOverride}
          />
        </div>
      )}
    </div>
  );
};

export const CliLogsRichView = ({
  cliLogsTail,
  order = 'oldest-first',
  onScroll,
  containerRefCallback,
  searchQueryOverride,
  className,
}: CliLogsRichViewProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Tracks groups manually collapsed by user (default: all auto-expanded)
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(new Set());

  const groups = useMemo(() => parseStreamJsonToGroups(cliLogsTail), [cliLogsTail]);

  // Derive expanded state: all groups expanded unless manually collapsed
  const expandedGroupIds = useMemo(() => {
    const expanded = new Set<string>();
    for (const group of groups) {
      if (!collapsedGroupIds.has(group.id)) {
        expanded.add(group.id);
      }
    }
    return expanded;
  }, [groups, collapsedGroupIds]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) {
      if (order === 'newest-first') {
        scrollRef.current.scrollTop = 0;
      } else {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [cliLogsTail, order]);

  const handleGroupToggle = useCallback((groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleItemClick = useCallback((itemId: string) => {
    setExpandedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  if (groups.length === 0) {
    // cliLogsTail has data but no parseable assistant messages — show raw text fallback
    const hasContent = cliLogsTail.trim().length > 0;
    return (
      <div
        ref={(el) => {
          scrollRef.current = el;
          containerRefCallback?.(el);
        }}
        className={cn(
          'max-h-[400px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]',
          className
        )}
        onScroll={(e) => {
          const el = e.currentTarget;
          onScroll?.({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
        }}
      >
        {hasContent ? (
          <pre className="p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            {cliLogsTail}
          </pre>
        ) : (
          <p className="p-3 text-center text-[11px] italic text-[var(--color-text-muted)]">
            Waiting for CLI output...
          </p>
        )}
      </div>
    );
  }

  const visibleGroups = order === 'newest-first' ? [...groups].reverse() : groups;

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        containerRefCallback?.(el);
      }}
      className={cn('max-h-[400px] space-y-1.5 overflow-y-auto', className)}
      onScroll={(e) => {
        const el = e.currentTarget;
        onScroll?.({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }}
    >
      {visibleGroups.map((group) =>
        group.items.length === 1 ? (
          // Single item — render flat without collapsible group wrapper
          <FlatGroupItem
            key={group.id}
            group={group}
            expandedItemIds={expandedItemIds}
            onItemClick={handleItemClick}
            searchQueryOverride={searchQueryOverride}
          />
        ) : (
          <StreamGroup
            key={group.id}
            group={group}
            isExpanded={expandedGroupIds.has(group.id)}
            onToggle={() => handleGroupToggle(group.id)}
            expandedItemIds={expandedItemIds}
            onItemClick={handleItemClick}
            searchQueryOverride={searchQueryOverride}
          />
        )
      )}
    </div>
  );
};
