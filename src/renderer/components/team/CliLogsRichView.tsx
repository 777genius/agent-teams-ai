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
import { groupBySubagent, parseStreamJsonToGroups } from '@renderer/utils/streamJsonParser';
import { Bot, ChevronRight } from 'lucide-react';

import type { StreamJsonGroup, SubagentSection } from '@renderer/utils/streamJsonParser';

type CliLogsOrder = 'oldest-first' | 'newest-first';

interface CliLogsRichViewProps {
  cliLogsTail: string;
  order?: CliLogsOrder;
  onScroll?: (params: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void;
  containerRefCallback?: (el: HTMLDivElement | null) => void;
  /** Optional local search query override for inline highlighting */
  searchQueryOverride?: string;
  className?: string;
  /** Content rendered at the very bottom of the scroll container (e.g. "Show more" button). */
  footer?: React.ReactNode;
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
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
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
            ? highlightQueryInText(
                group.summary,
                searchQueryOverride,
                `${group.id}:group-summary`,
                {
                  forceAllActive: true,
                }
              )
            : group.summary}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-[var(--color-border)] p-1.5">
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

/**
 * Collapsible section wrapping all groups from one subagent.
 * Collapsed by default.
 */
const SubagentSectionBlock = ({
  section,
  isExpanded,
  onToggle,
  collapsedGroupIds,
  onGroupToggle,
  expandedItemIds,
  onItemClick,
  searchQueryOverride,
}: {
  section: SubagentSection;
  isExpanded: boolean;
  onToggle: () => void;
  collapsedGroupIds: Set<string>;
  onGroupToggle: (groupId: string) => void;
  expandedItemIds: Set<string>;
  onItemClick: (itemId: string) => void;
  searchQueryOverride?: string;
}): React.JSX.Element => {
  const label = `Agent — ${section.description} (${section.toolCount} tool${section.toolCount !== 1 ? 's' : ''})`;

  return (
    <div className="rounded border border-l-2 border-amber-500/30 bg-[var(--color-surface)]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
        onClick={onToggle}
      >
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-amber-400 transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        <Bot size={13} className="shrink-0 text-amber-400" />
        <span className="min-w-0 truncate text-[11px] text-amber-300/80">
          {searchQueryOverride && searchQueryOverride.trim().length > 0
            ? highlightQueryInText(label, searchQueryOverride, `${section.id}:section-summary`, {
                forceAllActive: true,
              })
            : label}
        </span>
      </button>
      {isExpanded && (
        <div className="space-y-1 border-t border-amber-500/20 p-1.5">
          {section.groups.map((group) =>
            group.items.length === 1 ? (
              <FlatGroupItem
                key={group.id}
                group={group}
                expandedItemIds={expandedItemIds}
                onItemClick={onItemClick}
                searchQueryOverride={searchQueryOverride}
              />
            ) : (
              <StreamGroup
                key={group.id}
                group={group}
                isExpanded={!collapsedGroupIds.has(group.id)}
                onToggle={() => onGroupToggle(group.id)}
                expandedItemIds={expandedItemIds}
                onItemClick={onItemClick}
                searchQueryOverride={searchQueryOverride}
              />
            )
          )}
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
  footer,
}: CliLogsRichViewProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToEdgeRef = useRef(true);
  const lastOrderRef = useRef<CliLogsOrder>(order);
  // Tracks groups manually collapsed by user (default: all auto-expanded)
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(new Set());
  // Subagent sections are collapsed by default; track which are expanded
  const [expandedSubagentIds, setExpandedSubagentIds] = useState<Set<string>>(new Set());

  const groups = useMemo(() => parseStreamJsonToGroups(cliLogsTail), [cliLogsTail]);
  const entries = useMemo(() => groupBySubagent(groups), [groups]);

  // Derive expanded state: all groups expanded unless manually collapsed
  const expandedGroupIds = useMemo(() => {
    const expanded = new Set<string>();
    const addGroups = (gs: StreamJsonGroup[]): void => {
      for (const g of gs) {
        if (!collapsedGroupIds.has(g.id)) expanded.add(g.id);
      }
    };
    for (const entry of entries) {
      if (entry.type === 'group') {
        if (!collapsedGroupIds.has(entry.group.id)) expanded.add(entry.group.id);
      } else {
        addGroups(entry.section.groups);
      }
    }
    return expanded;
  }, [entries, collapsedGroupIds]);

  const computeShouldStickToEdge = useCallback(
    (el: HTMLDivElement): boolean => {
      // Small threshold makes it feel "sticky" but still allows reading slightly away from the edge
      const thresholdPx = 16;
      if (order === 'newest-first') {
        return el.scrollTop <= thresholdPx;
      }
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distanceFromBottom <= thresholdPx;
    },
    [order]
  );

  // Auto-scroll only when user is pinned to the edge.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // If the sort order changes, always snap once (expectation: show the "newest edge").
    if (lastOrderRef.current !== order) {
      lastOrderRef.current = order;
      stickToEdgeRef.current = true;
    }

    if (!stickToEdgeRef.current) return;

    if (order === 'newest-first') {
      el.scrollTop = 0;
      return;
    }

    el.scrollTop = el.scrollHeight;
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

  const handleSubagentToggle = useCallback((sectionId: string) => {
    setExpandedSubagentIds((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  if (entries.length === 0) {
    // No parseable assistant messages yet — show waiting state
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
          stickToEdgeRef.current = computeShouldStickToEdge(el);
          onScroll?.({
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }}
      >
        <div className="flex items-center gap-2 p-3">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-text-muted)] opacity-40" />
            <span className="relative inline-flex size-2 rounded-full bg-[var(--color-text-muted)]" />
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            Waiting for response...
          </span>
        </div>
        {footer}
      </div>
    );
  }

  const visibleEntries = order === 'newest-first' ? [...entries].reverse() : entries;

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        containerRefCallback?.(el);
      }}
      className={cn('cli-logs-compact max-h-[400px] space-y-1 overflow-y-auto', className)}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToEdgeRef.current = computeShouldStickToEdge(el);
        onScroll?.({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
      }}
    >
      {visibleEntries.map((entry) =>
        entry.type === 'subagent-section' ? (
          <SubagentSectionBlock
            key={entry.section.id}
            section={entry.section}
            isExpanded={expandedSubagentIds.has(entry.section.id)}
            onToggle={() => handleSubagentToggle(entry.section.id)}
            collapsedGroupIds={collapsedGroupIds}
            onGroupToggle={handleGroupToggle}
            expandedItemIds={expandedItemIds}
            onItemClick={handleItemClick}
            searchQueryOverride={searchQueryOverride}
          />
        ) : entry.group.items.length === 1 ? (
          <FlatGroupItem
            key={entry.group.id}
            group={entry.group}
            expandedItemIds={expandedItemIds}
            onItemClick={handleItemClick}
            searchQueryOverride={searchQueryOverride}
          />
        ) : (
          <StreamGroup
            key={entry.group.id}
            group={entry.group}
            isExpanded={expandedGroupIds.has(entry.group.id)}
            onToggle={() => handleGroupToggle(entry.group.id)}
            expandedItemIds={expandedItemIds}
            onItemClick={handleItemClick}
            searchQueryOverride={searchQueryOverride}
          />
        )
      )}
      {footer}
    </div>
  );
};
