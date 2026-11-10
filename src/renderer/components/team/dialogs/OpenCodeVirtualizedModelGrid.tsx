import React, { useMemo, useRef } from 'react';

import { cn } from '@renderer/lib/utils';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';

import { useModelGridColumnCount } from './ResponsiveModelGrid';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { VirtualItem } from '@tanstack/react-virtual';

interface ModelGroup {
  groupId: string;
  options: TeamRuntimeModelOption[];
}
interface HeadingRow<Group> {
  kind: 'heading';
  key: string;
  group: Group;
}
interface ModelRow {
  kind: 'models';
  key: string;
  groupId: string | null;
  options: TeamRuntimeModelOption[];
  isLastInGroup: boolean;
}
type VirtualRow<Group> = HeadingRow<Group> | ModelRow;

function buildVirtualRows<Group extends ModelGroup>(
  defaultOptions: TeamRuntimeModelOption[],
  groups: Group[],
  columnCount: number
): VirtualRow<Group>[] {
  const rows: VirtualRow<Group>[] = [];
  if (defaultOptions.length > 0) {
    rows.push({
      kind: 'models',
      key: 'default',
      groupId: null,
      options: defaultOptions,
      isLastInGroup: true,
    });
  }
  for (const group of groups) {
    rows.push({ kind: 'heading', key: `heading:${group.groupId}`, group });
    for (let start = 0; start < group.options.length; start += columnCount) {
      rows.push({
        kind: 'models',
        key: `models:${group.groupId}:${start}`,
        groupId: group.groupId,
        options: group.options.slice(start, start + columnCount),
        isLastInGroup: start + columnCount >= group.options.length,
      });
    }
  }
  return rows;
}

export function OpenCodeVirtualizedModelGrid<Group extends ModelGroup>({
  defaultOptions,
  groups,
  renderModelOption,
  renderGroupHeader,
  heightClassName,
}: Readonly<{
  defaultOptions: TeamRuntimeModelOption[];
  groups: Group[];
  renderModelOption: (option: TeamRuntimeModelOption) => React.JSX.Element;
  renderGroupHeader: (group: Group) => React.JSX.Element;
  heightClassName: string;
}>): React.JSX.Element {
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const columnCount = useModelGridColumnCount(scrollParentRef);
  const rows = useMemo(
    () => buildVirtualRows(defaultOptions, groups, columnCount),
    [columnCount, defaultOptions, groups]
  );
  const headingIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'heading' ? [index] : [])),
    [rows]
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual API limitation, not fixable in user code
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollParentRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => (rows[index]?.kind === 'heading' ? 38 : 74),
    // Keep each lightweight heading mounted so its original DOM node can stick
    // within its provider section. Only the expensive model tiles are windowed.
    rangeExtractor: (range) =>
      [...new Set([...headingIndexes, ...defaultRangeExtractor(range)])].sort(
        (left, right) => left - right
      ),
    overscan: 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualRowByIndex = new Map(virtualRows.map((row) => [row.index, row]));
  const modelRowsByGroup = new Map<string | null, VirtualItem[]>();
  for (const virtualRow of virtualRows) {
    const row = rows[virtualRow.index];
    if (row?.kind !== 'models') continue;
    const groupRows = modelRowsByGroup.get(row.groupId) ?? [];
    groupRows.push(virtualRow);
    modelRowsByGroup.set(row.groupId, groupRows);
  }
  const totalSize = rowVirtualizer.getTotalSize();

  const renderModelRow = (virtualRow: VirtualItem, sectionStart: number): React.ReactNode => {
    const row = rows[virtualRow.index];
    if (row?.kind !== 'models') return null;
    return (
      <div
        key={row.key}
        ref={rowVirtualizer.measureElement}
        data-index={virtualRow.index}
        className={cn('absolute left-0 w-full', row.isLastInGroup && 'pb-4')}
        style={{ top: virtualRow.start - sectionStart }}
      >
        <div
          className="grid border-l border-[var(--color-border-subtle)]"
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {row.options.map(renderModelOption)}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={scrollParentRef}
      data-testid="team-model-selector-model-grid"
      className={cn(
        '-mx-4 -mb-4 w-[calc(100%+2rem)] flex-none overflow-y-auto rounded-none bg-[var(--color-surface)]',
        heightClassName
      )}
    >
      <div className="relative w-full" style={{ height: totalSize }}>
        {(modelRowsByGroup.get(null) ?? []).map((virtualRow) => renderModelRow(virtualRow, 0))}
        {headingIndexes.map((headingIndex, position) => {
          const row = rows[headingIndex];
          const heading = virtualRowByIndex.get(headingIndex);
          if (row?.kind !== 'heading' || !heading) return null;
          const nextHeadingIndex = headingIndexes[position + 1];
          const nextHeading =
            nextHeadingIndex === undefined ? undefined : virtualRowByIndex.get(nextHeadingIndex);
          const sectionEnd = nextHeading?.start ?? totalSize;
          return (
            <section
              key={row.key}
              data-testid="team-model-selector-opencode-group"
              className="absolute left-0 w-full"
              style={{ top: heading.start, height: sectionEnd - heading.start }}
            >
              <div
                ref={rowVirtualizer.measureElement}
                data-index={headingIndex}
                data-testid="team-model-selector-sticky-group-header"
                className="sticky top-0 z-20 shadow-[0_6px_14px_-10px_rgba(0,0,0,0.9)]"
              >
                {renderGroupHeader(row.group)}
              </div>
              {(modelRowsByGroup.get(row.group.groupId) ?? []).map((virtualRow) =>
                renderModelRow(virtualRow, heading.start)
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
