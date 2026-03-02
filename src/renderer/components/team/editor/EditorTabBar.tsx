/**
 * Tab bar for the project editor.
 * Shows open files as tabs with dirty indicator (dot), close button,
 * right-click context menu (close others, close to left/right, close all),
 * and drag-and-drop reordering via @dnd-kit.
 */

import { useCallback, useMemo, useState } from 'react';

import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { EditorTabContextMenu } from './EditorTabContextMenu';
import { FileIcon } from './FileIcon';

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { EditorFileTab } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface EditorTabBarProps {
  /** Called instead of direct closeTab — allows parent to intercept dirty tabs */
  onRequestCloseTab: (tabId: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export const EditorTabBar = ({
  onRequestCloseTab,
}: EditorTabBarProps): React.ReactElement | null => {
  const { tabs, activeTabId, modifiedFiles } = useStore(
    useShallow((s) => ({
      tabs: s.editorOpenTabs,
      activeTabId: s.editorActiveTabId,
      modifiedFiles: s.editorModifiedFiles,
    }))
  );
  const setActiveEditorTab = useStore((s) => s.setActiveEditorTab);
  const reorderEditorTabs = useStore((s) => s.reorderEditorTabs);
  const closeOtherEditorTabs = useStore((s) => s.closeOtherEditorTabs);
  const closeEditorTabsToLeft = useStore((s) => s.closeEditorTabsToLeft);
  const closeEditorTabsToRight = useStore((s) => s.closeEditorTabsToRight);
  const closeAllEditorTabs = useStore((s) => s.closeAllEditorTabs);

  const [draggedTab, setDraggedTab] = useState<EditorFileTab | null>(null);

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tab = tabs.find((t) => t.id === event.active.id);
      setDraggedTab(tab ?? null);
    },
    [tabs]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedTab(null);
      const { active, over } = event;
      if (over && active.id !== over.id) {
        reorderEditorTabs(String(active.id), String(over.id));
      }
    },
    [reorderEditorTabs]
  );

  const handleDragCancel = useCallback(() => {
    setDraggedTab(null);
  }, []);

  if (tabs.length === 0) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-surface-sidebar"
        role="tablist"
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab, index) => (
            <SortableEditorTab
              key={tab.id}
              tab={tab}
              tabIndex={index}
              totalTabs={tabs.length}
              isActive={tab.id === activeTabId}
              isModified={!!modifiedFiles[tab.filePath]}
              onActivate={() => setActiveEditorTab(tab.id)}
              onRequestClose={onRequestCloseTab}
              onCloseOthers={closeOtherEditorTabs}
              onCloseToLeft={closeEditorTabsToLeft}
              onCloseToRight={closeEditorTabsToRight}
              onCloseAll={closeAllEditorTabs}
            />
          ))}
        </SortableContext>
      </div>

      <DragOverlay dropAnimation={null}>
        {draggedTab && <EditorTabOverlay tab={draggedTab} />}
      </DragOverlay>
    </DndContext>
  );
};

// =============================================================================
// Sortable tab item
// =============================================================================

interface SortableEditorTabProps {
  tab: EditorFileTab;
  tabIndex: number;
  totalTabs: number;
  isActive: boolean;
  isModified: boolean;
  onActivate: () => void;
  onRequestClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToLeft: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseAll: () => void;
}

const SortableEditorTab = ({
  tab,
  tabIndex,
  totalTabs,
  isActive,
  isModified,
  onActivate,
  onRequestClose,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseAll,
}: SortableEditorTabProps): React.ReactElement => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRequestClose(tab.id);
  };

  const handleAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onRequestClose(tab.id);
    }
  };

  return (
    // Sortable wrapper — must be the outermost element so @dnd-kit controls its position.
    // ContextMenu.Trigger inside EditorTabContextMenu adds an extra <div>,
    // so the useSortable ref/transform CANNOT live on the inner <button>.
    <div
      ref={setNodeRef}
      style={style}
      className="flex h-full shrink-0"
      // eslint-disable-next-line react/jsx-props-no-spreading -- @dnd-kit useSortable requires prop spreading
      {...attributes}
      // eslint-disable-next-line react/jsx-props-no-spreading -- @dnd-kit useSortable requires prop spreading
      {...listeners}
    >
      <EditorTabContextMenu
        tabId={tab.id}
        tabIndex={tabIndex}
        totalTabs={totalTabs}
        onClose={onRequestClose}
        onCloseOthers={onCloseOthers}
        onCloseToLeft={onCloseToLeft}
        onCloseToRight={onCloseToRight}
        onCloseAll={onCloseAll}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onActivate}
              onAuxClick={handleAuxClick}
              role="tab"
              aria-selected={isActive}
              className={`group flex h-full shrink-0 cursor-grab items-center gap-1.5 border-r border-border px-3 text-xs transition-colors ${
                isActive
                  ? 'bg-surface text-text'
                  : 'bg-surface-sidebar text-text-muted hover:bg-surface-raised hover:text-text-secondary'
              }`}
            >
              {isModified && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-400"
                  aria-label="Unsaved changes"
                />
              )}
              <FileIcon fileName={tab.fileName} className="size-3.5" />
              <span className="max-w-40 truncate">
                {tab.fileName}
                {tab.disambiguatedLabel && (
                  <span className="ml-1 text-text-muted">{tab.disambiguatedLabel}</span>
                )}
              </span>
              <span
                onClick={handleClose}
                onPointerDown={(e) => e.stopPropagation()}
                className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-raised group-hover:opacity-100"
                role="button"
                aria-label={`Close ${tab.fileName}`}
                tabIndex={-1}
              >
                <X className="size-3" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tab.filePath}</TooltipContent>
        </Tooltip>
      </EditorTabContextMenu>
    </div>
  );
};

// =============================================================================
// Drag overlay (ghost shown while dragging)
// =============================================================================

const EditorTabOverlay = ({ tab }: { tab: EditorFileTab }): React.ReactElement => (
  <div className="flex items-center gap-1.5 rounded border border-border-emphasis bg-surface-raised px-3 py-1 text-xs text-text shadow-lg">
    <FileIcon fileName={tab.fileName} className="size-3.5" />
    <span className="max-w-40 truncate">{tab.fileName}</span>
  </div>
);
