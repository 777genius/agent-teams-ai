/**
 * CliLogsRichView
 *
 * Renders CLI stream-json logs using the same rich components as session views:
 * thinking blocks, tool call cards, markdown text output.
 *
 * Supports two modes:
 * - **Uncontrolled** (default): manages its own expansion and viewport state internally.
 * - **Controlled**: accepts external state + callbacks so the parent can persist
 *   expansion and viewport across surface switches (e.g. compact ↔ dialog).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DisplayItemList } from '@renderer/components/chat/DisplayItemList';
import { highlightQueryInText } from '@renderer/components/chat/searchHighlightUtils';
import { cn } from '@renderer/lib/utils';
import { groupBySubagent, parseStreamJsonToGroups } from '@renderer/utils/streamJsonParser';
import { Bot, ChevronRight } from 'lucide-react';

import type { StreamJsonGroup, SubagentSection } from '@renderer/utils/streamJsonParser';

// =============================================================================
// Viewport state types
// =============================================================================

export type CliLogsOrder = 'oldest-first' | 'newest-first';

export type ClaudeLogsViewportState =
  | { mode: 'edge'; edge: 'newest' | 'oldest' }
  | { mode: 'anchor'; anchorId: string; offsetTop: number };

export interface ClaudeLogsViewerState {
  collapsedGroupIds: Set<string>;
  expandedItemIds: Set<string>;
  expandedSubagentIds: Set<string>;
  viewport: ClaudeLogsViewportState;
}

// =============================================================================
// Props
// =============================================================================

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

  // ── Controlled mode (optional — all-or-nothing) ──────────────────────
  /** When provided, the component uses external expansion state. */
  viewerState?: ClaudeLogsViewerState;
  /** Called whenever expansion or viewport state changes in controlled mode. */
  onViewerStateChange?: (state: ClaudeLogsViewerState) => void;
}

// =============================================================================
// Helpers
// =============================================================================

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

/** Finds the first visible anchor element and returns its id + offset from container top. */
function computeAnchorViewport(container: HTMLDivElement): ClaudeLogsViewportState | null {
  const anchors = container.querySelectorAll<HTMLElement>('[data-log-anchor]');
  const containerTop = container.getBoundingClientRect().top;
  const containerBottom = containerTop + container.clientHeight;

  for (const anchor of anchors) {
    const rect = anchor.getBoundingClientRect();
    // First anchor whose bottom is within or below the container top
    if (rect.bottom > containerTop && rect.top < containerBottom) {
      const anchorId = anchor.dataset.logAnchor;
      if (anchorId) {
        return { mode: 'anchor', anchorId, offsetTop: rect.top - containerTop };
      }
    }
  }
  return null;
}

/** Restores scroll position from a viewport state after mount/layout. */
function restoreViewport(
  container: HTMLDivElement,
  viewport: ClaudeLogsViewportState,
  order: CliLogsOrder
): void {
  if (viewport.mode === 'edge') {
    if (viewport.edge === 'newest') {
      // eslint-disable-next-line no-param-reassign -- DOM scroll positioning requires direct mutation
      container.scrollTop = order === 'newest-first' ? 0 : container.scrollHeight;
    } else {
      // eslint-disable-next-line no-param-reassign -- DOM scroll positioning requires direct mutation
      container.scrollTop = order === 'newest-first' ? container.scrollHeight : 0;
    }
    return;
  }

  // Anchor mode — find the element and adjust scroll
  const el = container.querySelector<HTMLElement>(`[data-log-anchor="${viewport.anchorId}"]`);
  if (!el) return;

  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const currentOffset = elRect.top - containerRect.top;
  // eslint-disable-next-line no-param-reassign -- DOM scroll positioning requires direct mutation
  container.scrollTop += currentOffset - viewport.offsetTop;
}

// =============================================================================
// Sub-components
// =============================================================================

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
    <div data-log-anchor={group.id}>
      <DisplayItemList
        items={group.items}
        onItemClick={handleItemClick}
        expandedItemIds={groupItemIds}
        aiGroupId={group.id}
        searchQueryOverride={searchQueryOverride}
        previewMaxLength={500}
      />
    </div>
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
    <div
      data-log-anchor={group.id}
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
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
            previewMaxLength={500}
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
    <div
      data-log-anchor={section.id}
      className="rounded border border-l-2 border-amber-500/30 bg-[var(--color-surface)]"
    >
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

// =============================================================================
// Hook: useToggleSet — shared toggle logic for Set<string> state
// =============================================================================

function toggleInSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// =============================================================================
// Main component
// =============================================================================

export const CliLogsRichView = ({
  cliLogsTail,
  order = 'oldest-first',
  onScroll,
  containerRefCallback,
  searchQueryOverride,
  className,
  footer,
  viewerState: controlledState,
  onViewerStateChange,
}: CliLogsRichViewProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToEdgeRef = useRef(true);
  const lastOrderRef = useRef<CliLogsOrder>(order);
  const hasRestoredRef = useRef(false);

  // ── Internal state (used in uncontrolled mode) ──────────────────────
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set());
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set());
  const [internalSubagent, setInternalSubagent] = useState<Set<string>>(new Set());

  // ── Resolve controlled vs internal ──────────────────────────────────
  const isControlled = controlledState !== undefined;
  const collapsedGroupIds = isControlled ? controlledState.collapsedGroupIds : internalCollapsed;
  const expandedItemIds = isControlled ? controlledState.expandedItemIds : internalExpanded;
  const expandedSubagentIds = isControlled ? controlledState.expandedSubagentIds : internalSubagent;

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

  // ── Viewport computation ────────────────────────────────────────────

  const computeCurrentViewport = useCallback(
    (el: HTMLDivElement): ClaudeLogsViewportState => {
      const thresholdPx = 16;

      // Check if at the "newest" edge
      if (order === 'newest-first' && el.scrollTop <= thresholdPx) {
        return { mode: 'edge', edge: 'newest' };
      }
      if (
        order === 'oldest-first' &&
        el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx
      ) {
        return { mode: 'edge', edge: 'newest' };
      }

      // Check if at the "oldest" edge
      if (order === 'newest-first') {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distFromBottom <= thresholdPx) {
          return { mode: 'edge', edge: 'oldest' };
        }
      }
      if (order === 'oldest-first' && el.scrollTop <= thresholdPx) {
        return { mode: 'edge', edge: 'oldest' };
      }

      // Anchor mode — find first visible anchor
      const anchor = computeAnchorViewport(el);
      return anchor ?? { mode: 'edge', edge: 'newest' };
    },
    [order]
  );

  const computeShouldStickToEdge = useCallback(
    (el: HTMLDivElement): boolean => {
      const thresholdPx = 16;
      if (order === 'newest-first') {
        return el.scrollTop <= thresholdPx;
      }
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distanceFromBottom <= thresholdPx;
    },
    [order]
  );

  // ── Viewport restoration on controlled mount ────────────────────────

  useEffect(() => {
    if (!isControlled || hasRestoredRef.current) return;
    const el = scrollRef.current;
    if (!el || entries.length === 0) return;

    hasRestoredRef.current = true;

    // Use rAF to ensure layout is complete before restoring
    requestAnimationFrame(() => {
      restoreViewport(el, controlledState.viewport, order);
      stickToEdgeRef.current = computeShouldStickToEdge(el);
    });
  }, [isControlled, controlledState?.viewport, entries.length, order, computeShouldStickToEdge]);

  // Reset restore flag when controlled state is first attached
  useEffect(() => {
    if (isControlled) {
      hasRestoredRef.current = false;
    }
  }, [isControlled]);

  // ── Auto-scroll when pinned to edge ─────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

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

  // ── State change handlers ───────────────────────────────────────────

  const emitStateChange = useCallback(
    (patch: Partial<ClaudeLogsViewerState>) => {
      if (!isControlled || !onViewerStateChange) return;
      onViewerStateChange({ ...controlledState, ...patch });
    },
    [isControlled, onViewerStateChange, controlledState]
  );

  const handleGroupToggle = useCallback(
    (groupId: string) => {
      if (isControlled) {
        emitStateChange({ collapsedGroupIds: toggleInSet(collapsedGroupIds, groupId) });
      } else {
        setInternalCollapsed((prev) => toggleInSet(prev, groupId));
      }
    },
    [isControlled, emitStateChange, collapsedGroupIds]
  );

  const handleItemClick = useCallback(
    (itemId: string) => {
      if (isControlled) {
        emitStateChange({ expandedItemIds: toggleInSet(expandedItemIds, itemId) });
      } else {
        setInternalExpanded((prev) => toggleInSet(prev, itemId));
      }
    },
    [isControlled, emitStateChange, expandedItemIds]
  );

  const handleSubagentToggle = useCallback(
    (sectionId: string) => {
      if (isControlled) {
        emitStateChange({ expandedSubagentIds: toggleInSet(expandedSubagentIds, sectionId) });
      } else {
        setInternalSubagent((prev) => toggleInSet(prev, sectionId));
      }
    },
    [isControlled, emitStateChange, expandedSubagentIds]
  );

  // ── Scroll handler ──────────────────────────────────────────────────

  const handleScrollEvent = useCallback(
    (el: HTMLDivElement) => {
      stickToEdgeRef.current = computeShouldStickToEdge(el);

      onScroll?.({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });

      // Report viewport state to parent in controlled mode
      if (isControlled && onViewerStateChange) {
        const vp = computeCurrentViewport(el);
        emitStateChange({ viewport: vp });
      }
    },
    [
      computeShouldStickToEdge,
      computeCurrentViewport,
      emitStateChange,
      isControlled,
      onScroll,
      onViewerStateChange,
    ]
  );

  // ── Render ──────────────────────────────────────────────────────────

  if (entries.length === 0) {
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
        onScroll={(e) => handleScrollEvent(e.currentTarget)}
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
      onScroll={(e) => handleScrollEvent(e.currentTarget)}
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
