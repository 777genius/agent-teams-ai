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
import { cn } from '@renderer/lib/utils';
import { parseStreamJsonToGroups } from '@renderer/utils/streamJsonParser';
import { Bot, ChevronRight } from 'lucide-react';

import type { StreamJsonGroup } from '@renderer/utils/streamJsonParser';

interface CliLogsRichViewProps {
  cliLogsTail: string;
  className?: string;
}

/**
 * A single collapsible group of assistant items.
 */
const StreamGroup = ({
  group,
  isExpanded,
  onToggle,
  expandedItemIds,
  onItemClick,
}: {
  group: StreamJsonGroup;
  isExpanded: boolean;
  onToggle: () => void;
  expandedItemIds: Set<string>;
  onItemClick: (itemId: string) => void;
}): React.JSX.Element => (
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
        {group.summary}
      </span>
    </button>
    {isExpanded && (
      <div className="border-t border-[var(--color-border)] p-2">
        <DisplayItemList
          items={group.items}
          onItemClick={onItemClick}
          expandedItemIds={expandedItemIds}
          aiGroupId={group.id}
        />
      </div>
    )}
  </div>
);

export const CliLogsRichView = ({
  cliLogsTail,
  className,
}: CliLogsRichViewProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null);
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
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [cliLogsTail]);

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
        className={cn(
          'rounded border border-[var(--color-border)] bg-[var(--color-surface)]',
          className
        )}
      >
        {hasContent ? (
          <pre className="max-h-[400px] overflow-y-auto p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
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

  return (
    <div ref={scrollRef} className={cn('max-h-[400px] space-y-1.5 overflow-y-auto', className)}>
      {groups.map((group) => (
        <StreamGroup
          key={group.id}
          group={group}
          isExpanded={expandedGroupIds.has(group.id)}
          onToggle={() => handleGroupToggle(group.id)}
          expandedItemIds={expandedItemIds}
          onItemClick={handleItemClick}
        />
      ))}
    </div>
  );
};
