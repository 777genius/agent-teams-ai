/* eslint-disable tailwindcss/no-custom-classname -- this adapter needs stable non-Tailwind class hooks for react-grid-layout handles. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactGridLayout, { WidthProvider } from 'react-grid-layout/legacy';

import { usePersistedGridLayout } from '@renderer/hooks/usePersistedGridLayout';
import { browserGridLayoutRepository } from '@renderer/services/layout-system/BrowserGridLayoutRepository';
import { GripVertical } from 'lucide-react';

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
const GRID_SCOPE_KEY = 'kanban-grid-layout:global';
const SKELETON_HIDE_DELAY_MS = 500;
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
}

interface KanbanGridLayoutProps {
  columns: KanbanGridColumn[];
  allColumnIds: KanbanColumnId[];
}

interface LoadedKanbanGridLayoutProps {
  readonly columns: KanbanGridColumn[];
  readonly visibleItems: PersistedGridLayoutItem[];
  readonly onPersistLayout: (layout: Layout, options?: { persist?: boolean }) => void;
}

interface LoadingKanbanGridLayoutProps {
  readonly columns: KanbanGridColumn[];
  readonly visibleItems: PersistedGridLayoutItem[];
}

function buildDefaultItems(itemIds: string[]): PersistedGridLayoutItem[] {
  return itemIds.map((id, index) => ({
    id,
    x: (index % 3) * DEFAULT_ITEM_WIDTH,
    y: Math.floor(index / 3) * DEFAULT_ITEM_HEIGHT,
    w: DEFAULT_ITEM_WIDTH,
    h: DEFAULT_ITEM_HEIGHT,
    minW: DEFAULT_MIN_WIDTH,
    minH: DEFAULT_MIN_HEIGHT,
  }));
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

const LoadingKanbanGridLayout = ({
  columns,
  visibleItems,
}: Readonly<LoadingKanbanGridLayoutProps>): ReactElement => {
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const loadingItems =
    visibleItems.length > 0
      ? visibleItems
      : buildDefaultItems(columns.length > 0 ? columns.map((column) => column.id) : ['todo']);

  return (
    <div>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridAutoRows: `${GRID_ROW_HEIGHT}px`,
        }}
      >
        {loadingItems.map((item) => {
          const column = columnMap.get(item.id as KanbanColumnId);

          return (
            <section
              key={item.id}
              className="min-h-[400px] animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
              style={{
                gridColumn: `${item.x + 1} / span ${item.w}`,
                gridRow: `${item.y + 1} / span ${item.h}`,
              }}
            >
              <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
                <div
                  className="h-5 rounded bg-[var(--color-surface-raised)]"
                  style={{ width: column ? 96 : 72 }}
                />
                <div className="h-6 w-10 rounded-md bg-[var(--color-surface-raised)]" />
              </header>
              <div className="flex h-[calc(100%-41px)] flex-col gap-3 p-3">
                <div className="bg-[var(--color-surface-raised)]/35 h-12 rounded-md border border-dashed border-[var(--color-border-emphasis)]" />
                <div className="h-24 rounded-md bg-[var(--color-surface-raised)]" />
                <div className="bg-[var(--color-surface-raised)]/80 h-20 rounded-md" />
                <div className="bg-[var(--color-surface-raised)]/60 h-16 rounded-md" />
              </div>
            </section>
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
}: Readonly<LoadedKanbanGridLayoutProps>): ReactElement => {
  const columnMap = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const [renderLayout, setRenderLayout] = useState<Layout>(() =>
    visibleItems.map(toReactGridLayoutItem)
  );

  const applyReactGridLayout = useCallback(
    (layout: Layout, options?: { persist?: boolean }) => {
      setRenderLayout(layout);
      if (options?.persist) {
        onPersistLayout(layout, options);
      }
    },
    [onPersistLayout]
  );

  return (
    <div>
      <WidthAwareGridLayout
        className="kanban-grid-layout"
        measureBeforeMount
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
                headerAccessory={
                  <button
                    type="button"
                    className="kanban-grid-drag-handle inline-flex cursor-grab items-center justify-center rounded-sm p-1 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] active:cursor-grabbing"
                    aria-label={`Drag ${column.title} column`}
                  >
                    <GripVertical size={14} />
                  </button>
                }
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
    if (!isLoaded || showResolvedLayout) return;

    const timeoutId = window.setTimeout(() => {
      setShowResolvedLayout(true);
    }, SKELETON_HIDE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isLoaded, showResolvedLayout]);

  const applyReactGridLayout = useCallback(
    (layout: Layout, options?: { persist?: boolean }) => {
      if (options?.persist) {
        applyVisibleItems(fromReactGridLayout(layout), options);
      }
    },
    [applyVisibleItems]
  );

  if (!isLoaded || !showResolvedLayout) {
    return <LoadingKanbanGridLayout columns={columns} visibleItems={visibleItems} />;
  }

  const gridKey = visibleItems.map((item) => item.id).join('|');

  return (
    <LoadedKanbanGridLayout
      key={gridKey}
      columns={columns}
      visibleItems={visibleItems}
      onPersistLayout={applyReactGridLayout}
    />
  );
};
/* eslint-enable tailwindcss/no-custom-classname -- stable class hooks remain scoped to this file. */
