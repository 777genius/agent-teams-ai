/* eslint-disable tailwindcss/no-custom-classname -- this adapter needs stable non-Tailwind class hooks for react-grid-layout handles. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactGridLayout, { WidthProvider } from 'react-grid-layout/legacy';

import { usePersistedGridLayout } from '@renderer/hooks/usePersistedGridLayout';
import { cn } from '@renderer/lib/utils';
import { browserGridLayoutRepository } from '@renderer/services/layout-system/BrowserGridLayoutRepository';

import { KanbanColumn } from './KanbanColumn';

import type { PersistedGridLayoutItem } from '@renderer/services/layout-system/gridLayoutTypes';
import type { KanbanColumnId } from '@shared/types';
import type { ReactElement, Ref } from 'react';
import type { Layout, LayoutItem, ResizeHandleAxis } from 'react-grid-layout/legacy';

const GRID_COLS = 12;
const GRID_ROW_HEIGHT = 18;
const GRID_MARGIN: [number, number] = [12, 12];
const DEFAULT_ITEM_WIDTH = 4;
const DEFAULT_ITEM_HEIGHT_PX = 400;
const DEFAULT_ITEM_HEIGHT = Math.max(
  1,
  Math.round((DEFAULT_ITEM_HEIGHT_PX + GRID_MARGIN[1]) / (GRID_ROW_HEIGHT + GRID_MARGIN[1]))
);
const DEFAULT_MIN_HEIGHT = 10;
const DEFAULT_MIN_WIDTH = 3;
const GRID_SCOPE_KEY = 'kanban-grid-layout:global:v2';
const SKELETON_HIDE_DELAY_MS = 500;
const SKELETON_HIDE_DELAY_MS_ON_MODE_SWITCH = 750;
const RESIZE_HANDLES: ResizeHandleAxis[] = ['s', 'w', 'e', 'n', 'sw', 'nw', 'se', 'ne'];
const WidthAwareGridLayout = WidthProvider(ReactGridLayout);

export interface KanbanGridColumn {
  id: KanbanColumnId;
  title: string;
  count: number;
  icon?: React.ReactNode;
  headerBg?: string;
  bodyBg?: string;
  content: React.ReactNode;
  showAddButton?: boolean;
  skeletonCards?: {
    key: string;
    height: number;
  }[];
}

interface KanbanGridLayoutProps {
  columns: KanbanGridColumn[];
  allColumnIds: KanbanColumnId[];
  primaryColumnId?: KanbanColumnId | null;
  onPrimaryColumnWidthChange?: (width: number | null) => void;
  skeletonDelayMs?: number;
}

interface LoadedKanbanGridLayoutProps {
  readonly columns: KanbanGridColumn[];
  readonly visibleItems: PersistedGridLayoutItem[];
  readonly onPersistLayout: (layout: Layout, options?: { persist?: boolean }) => void;
  readonly primaryColumnId?: KanbanColumnId | null;
  readonly onPrimaryColumnWidthChange?: (width: number | null) => void;
  readonly className?: string;
}

interface LoadingKanbanGridLayoutProps {
  readonly columns: KanbanGridColumn[];
  readonly visibleItems: PersistedGridLayoutItem[];
  readonly primaryColumnId?: KanbanColumnId | null;
  readonly onPrimaryColumnWidthChange?: (width: number | null) => void;
  readonly className?: string;
}

const ITEMS_PER_FIRST_ROW = 3;
const SECOND_ROW_ITEM_WIDTH = 6;

function buildDefaultItems(itemIds: string[]): PersistedGridLayoutItem[] {
  return itemIds.map((id, index) => {
    const isSecondRow = index >= ITEMS_PER_FIRST_ROW;
    const w = isSecondRow ? SECOND_ROW_ITEM_WIDTH : DEFAULT_ITEM_WIDTH;
    const x = isSecondRow
      ? (index - ITEMS_PER_FIRST_ROW) * SECOND_ROW_ITEM_WIDTH
      : index * DEFAULT_ITEM_WIDTH;
    const y = isSecondRow ? DEFAULT_ITEM_HEIGHT : 0;
    return {
      id,
      x,
      y,
      w,
      h: DEFAULT_ITEM_HEIGHT,
      minW: DEFAULT_MIN_WIDTH,
      minH: DEFAULT_MIN_HEIGHT,
    };
  });
}

function toReactGridLayoutItem(item: PersistedGridLayoutItem): LayoutItem {
  return {
    i: item.id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
    maxW: item.maxW,
    maxH: item.maxH,
  };
}

function fromReactGridLayout(layout: Layout): PersistedGridLayoutItem[] {
  return layout.map((item) => ({
    id: item.i,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
    maxW: item.maxW,
    maxH: item.maxH,
  }));
}

function renderResizeHandle(axis: ResizeHandleAxis, ref: Ref<HTMLElement>): ReactElement {
  return (
    <span
      ref={ref}
      className={`kanban-grid-resize-handle kanban-grid-resize-handle-${axis}`}
      aria-hidden="true"
    />
  );
}

const KanbanTaskCardSkeleton = ({ height }: { height: number }): ReactElement => (
  <div
    className="relative shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-white dark:bg-[var(--color-surface-raised)]"
    style={{ height }}
  >
    <div className="bg-[var(--color-surface-overlay)]/30 absolute left-[3px] top-[4px] h-2 w-14 rounded" />
    <div className="bg-[var(--color-surface-overlay)]/25 absolute right-[6px] top-[4px] h-5 w-16 rounded-full" />
    <div className="flex h-full flex-col px-1.5 py-3">
      <div className="pt-[11px]">
        <div className="bg-[var(--color-surface-overlay)]/25 h-4 w-[84%] rounded" />
        <div className="bg-[var(--color-surface-overlay)]/18 mt-2 h-4 w-[68%] rounded" />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <div className="bg-[var(--color-surface-overlay)]/18 size-6 rounded-full border border-[var(--color-border)]" />
          <div className="bg-[var(--color-surface-overlay)]/18 size-6 rounded-full border border-[var(--color-border)]" />
        </div>
        <div className="flex gap-1.5">
          <div className="bg-[var(--color-surface-overlay)]/12 size-6 rounded-full border border-[var(--color-border)]" />
          <div className="bg-[var(--color-surface-overlay)]/12 size-6 rounded-full border border-[var(--color-border)]" />
        </div>
      </div>
    </div>
  </div>
);

const LoadingKanbanGridLayout = ({
  columns,
  visibleItems,
  primaryColumnId,
  onPrimaryColumnWidthChange,
  className,
}: Readonly<LoadingKanbanGridLayoutProps>): ReactElement => {
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const loadingItems =
    visibleItems.length > 0
      ? visibleItems
      : buildDefaultItems(columns.length > 0 ? columns.map((column) => column.id) : ['todo']);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = (): void => {
      setContainerWidth(element.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setContainerWidth(entry ? entry.contentRect.width : element.clientWidth);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const primaryColumnWidth = useMemo(() => {
    if (!primaryColumnId || containerWidth <= 0) {
      return null;
    }

    const layoutItem = loadingItems.find((item) => item.id === primaryColumnId);
    if (!layoutItem) {
      return null;
    }

    const columnUnitWidth = (containerWidth - GRID_MARGIN[0] * (GRID_COLS - 1)) / GRID_COLS;
    return Math.round(columnUnitWidth * layoutItem.w + GRID_MARGIN[0] * (layoutItem.w - 1));
  }, [containerWidth, loadingItems, primaryColumnId]);

  useEffect(() => {
    onPrimaryColumnWidthChange?.(primaryColumnWidth);
  }, [onPrimaryColumnWidthChange, primaryColumnWidth]);

  return (
    <div ref={containerRef} className={cn('min-w-0 max-w-full', className)}>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridAutoRows: `${GRID_ROW_HEIGHT}px`,
        }}
      >
        {loadingItems.map((item) => {
          const column = columnMap.get(item.id as KanbanColumnId);
          if (!column) {
            return <div key={item.id} />;
          }
          const skeletonCards = column.skeletonCards ?? [];
          const hasTasks = skeletonCards.length > 0;
          const showAddButton = column.showAddButton === true;

          return (
            <div
              key={item.id}
              className="min-h-0"
              style={{
                gridColumn: `${item.x + 1} / span ${item.w}`,
                gridRow: `${item.y + 1} / span ${item.h}`,
              }}
            >
              <KanbanColumn
                title={column.title}
                count={column.count}
                icon={column.icon}
                headerBg={column.headerBg}
                bodyBg={column.bodyBg}
                className="flex h-full min-h-0 animate-pulse flex-col"
                headerClassName="shrink-0"
                bodyClassName="min-h-0 max-h-none flex-1 overflow-hidden"
              >
                {hasTasks ? (
                  <>
                    {skeletonCards.map((card) => (
                      <KanbanTaskCardSkeleton key={card.key} height={card.height} />
                    ))}
                    {showAddButton ? (
                      <div className="bg-[var(--color-surface-overlay)]/15 flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 text-xs text-[var(--color-text-muted)]">
                        Add task
                      </div>
                    ) : null}
                  </>
                ) : showAddButton ? (
                  <div className="bg-[var(--color-surface-overlay)]/15 flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 text-xs text-[var(--color-text-muted)]">
                    Add task
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
                    No tasks
                  </div>
                )}
              </KanbanColumn>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const LoadedKanbanGridLayout = ({
  columns,
  visibleItems,
  onPersistLayout,
  primaryColumnId,
  onPrimaryColumnWidthChange,
  className,
}: Readonly<LoadedKanbanGridLayoutProps>): ReactElement => {
  const columnMap = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const visibleLayout = useMemo(() => visibleItems.map(toReactGridLayoutItem), [visibleItems]);
  const [renderLayout, setRenderLayout] = useState<Layout>(() => visibleLayout);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    setRenderLayout(visibleLayout);
  }, [visibleLayout]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = (): void => {
      setContainerWidth(element.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setContainerWidth(entry ? entry.contentRect.width : element.clientWidth);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const applyReactGridLayout = useCallback(
    (layout: Layout, options?: { persist?: boolean }) => {
      setRenderLayout(layout);
      if (options?.persist) {
        onPersistLayout(layout, options);
      }
    },
    [onPersistLayout]
  );

  const primaryColumnWidth = useMemo(() => {
    if (!primaryColumnId || containerWidth <= 0) {
      return null;
    }

    const layoutItem = renderLayout.find((item) => item.i === primaryColumnId);
    if (!layoutItem) {
      return null;
    }

    const columnUnitWidth = (containerWidth - GRID_MARGIN[0] * (GRID_COLS - 1)) / GRID_COLS;
    return Math.round(columnUnitWidth * layoutItem.w + GRID_MARGIN[0] * (layoutItem.w - 1));
  }, [containerWidth, primaryColumnId, renderLayout]);

  useEffect(() => {
    onPrimaryColumnWidthChange?.(primaryColumnWidth);
  }, [onPrimaryColumnWidthChange, primaryColumnWidth]);

  return (
    <div ref={containerRef} className={cn('min-w-0 max-w-full', className)}>
      <WidthAwareGridLayout
        className="kanban-grid-layout"
        layout={renderLayout}
        cols={GRID_COLS}
        rowHeight={GRID_ROW_HEIGHT}
        margin={GRID_MARGIN}
        containerPadding={[0, 0]}
        isDraggable
        isResizable
        draggableHandle=".kanban-grid-drag-handle"
        resizeHandles={RESIZE_HANDLES}
        resizeHandle={renderResizeHandle}
        onLayoutChange={(layout) => applyReactGridLayout(layout)}
        onDragStop={(layout) => applyReactGridLayout(layout, { persist: true })}
        onResizeStop={(layout) => applyReactGridLayout(layout, { persist: true })}
      >
        {visibleItems.map((layoutItem) => {
          const column = columnMap.get(layoutItem.id as KanbanColumnId);
          if (!column) {
            return <div key={layoutItem.id} />;
          }

          return (
            <div key={layoutItem.id} className="kanban-grid-item-wrapper min-h-0">
              <KanbanColumn
                title={column.title}
                count={column.count}
                icon={column.icon}
                headerBg={column.headerBg}
                bodyBg={column.bodyBg}
                className="flex h-full min-h-0 flex-col"
                headerClassName="shrink-0"
                bodyClassName="kanban-grid-no-drag min-h-0 max-h-none flex-1"
                headerDragClassName="kanban-grid-drag-handle cursor-grab active:cursor-grabbing"
              >
                {column.content}
              </KanbanColumn>
            </div>
          );
        })}
      </WidthAwareGridLayout>
    </div>
  );
};

export const KanbanGridLayout = ({
  columns,
  allColumnIds,
  primaryColumnId,
  onPrimaryColumnWidthChange,
  skeletonDelayMs = SKELETON_HIDE_DELAY_MS,
}: KanbanGridLayoutProps): React.JSX.Element => {
  const visibleColumnIds = useMemo(() => columns.map((column) => column.id), [columns]);
  const { visibleItems, applyVisibleItems, isLoaded } = usePersistedGridLayout({
    scopeKey: GRID_SCOPE_KEY,
    allItemIds: allColumnIds,
    visibleItemIds: visibleColumnIds,
    cols: GRID_COLS,
    repository: browserGridLayoutRepository,
    buildDefaultItems,
  });
  const [showResolvedLayout, setShowResolvedLayout] = useState(false);

  useEffect(() => {
    if (showResolvedLayout) return;

    const timeoutId = window.setTimeout(() => {
      setShowResolvedLayout(true);
    }, skeletonDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [showResolvedLayout, skeletonDelayMs]);

  const applyReactGridLayout = useCallback(
    (layout: Layout, options?: { persist?: boolean }) => {
      if (options?.persist) {
        applyVisibleItems(fromReactGridLayout(layout), options);
      }
    },
    [applyVisibleItems]
  );
  const showSkeletonOverlay = !showResolvedLayout || !isLoaded;

  const gridKey = visibleItems.map((item) => item.id).join('|');

  return (
    <div className="relative min-w-0 max-w-full">
      <LoadedKanbanGridLayout
        key={gridKey}
        columns={columns}
        visibleItems={visibleItems}
        onPersistLayout={applyReactGridLayout}
        primaryColumnId={primaryColumnId}
        onPrimaryColumnWidthChange={onPrimaryColumnWidthChange}
        className={cn(
          'transition-opacity duration-150',
          showSkeletonOverlay ? 'pointer-events-none opacity-0' : 'opacity-100'
        )}
      />
      {showSkeletonOverlay ? (
        <LoadingKanbanGridLayout
          columns={columns}
          visibleItems={visibleItems}
          primaryColumnId={primaryColumnId}
          onPrimaryColumnWidthChange={onPrimaryColumnWidthChange}
          className="pointer-events-none absolute inset-0 z-10"
        />
      ) : null}
    </div>
  );
};

export { SKELETON_HIDE_DELAY_MS, SKELETON_HIDE_DELAY_MS_ON_MODE_SWITCH };
/* eslint-enable tailwindcss/no-custom-classname -- stable class hooks remain scoped to this file. */
