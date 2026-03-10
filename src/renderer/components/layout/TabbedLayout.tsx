/**
 * TabbedLayout - Main layout with full-width tab bar, sidebar, and multi-pane content.
 *
 * Layout structure:
 * - TabBarRow (full width): Pane TabBars + action buttons
 * - Sidebar (280px): Task list / date-grouped sessions
 * - Main content: PaneContainer with one or more panes
 *
 * Owns the DndContext for tab drag-and-drop across the entire layout
 * (TabBarRow tabs + PaneContainer split zones).
 */

import { useCallback, useState } from 'react';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { isElectronMode } from '@renderer/api';
import { getTrafficLightPaddingForZoom } from '@renderer/constants/layout';
import { useFullScreen } from '@renderer/hooks/useFullScreen';
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';
import { useZoomFactor } from '@renderer/hooks/useZoomFactor';
import { useStore } from '@renderer/store';

import { UpdateBanner } from '../common/UpdateBanner';
import { UpdateDialog } from '../common/UpdateDialog';
import { WorkspaceIndicator } from '../common/WorkspaceIndicator';
import { CommandPalette } from '../search/CommandPalette';
import { GlobalTaskDetailDialog } from '../team/dialogs/GlobalTaskDetailDialog';

import { CustomTitleBar } from './CustomTitleBar';
import { PaneContainer } from './PaneContainer';
import { Sidebar } from './Sidebar';
import { DragOverlayTab } from './SortableTab';
import { TabBarActions } from './TabBarActions';
import { TabBarRow } from './TabBarRow';

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { Tab } from '@renderer/types/tabs';

export const TabbedLayout = (): React.JSX.Element => {
  useKeyboardShortcuts();
  const zoomFactor = useZoomFactor();
  const isFullScreen = useFullScreen();
  const trafficLightPadding = !isElectronMode()
    ? 0
    : isFullScreen
      ? 8
      : getTrafficLightPaddingForZoom(zoomFactor);

  // --- DnD state (lifted from PaneContainer) ---
  const panes = useStore((s) => s.paneLayout.panes);
  const [activeTab, setActiveTab] = useState<Tab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current;

      if (data?.type === 'tab') {
        const sourcePaneId = data.paneId as string;
        const tabId = data.tabId as string;

        const pane = panes.find((p) => p.id === sourcePaneId);
        const tab = pane?.tabs.find((t) => t.id === tabId);
        if (tab) {
          setActiveTab(tab);
        }
      }
    },
    [panes]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveTab(null);

      if (!over || !active.data.current) return;

      const activeData = active.data.current;
      const overData = over.data.current;

      if (activeData.type !== 'tab') return;

      const draggedTabId = activeData.tabId as string;
      const sourcePaneId = activeData.paneId as string;
      const state = useStore.getState();

      // Case 1: Drop on a split-zone (edge of pane) → create new pane
      if (overData?.type === 'split-zone') {
        const targetPaneId = overData.paneId as string;
        const side = overData.side as 'left' | 'right';
        state.moveTabToNewPane(draggedTabId, sourcePaneId, targetPaneId, side);
        return;
      }

      // Case 2: Drop on a tabbar (different pane) → move tab to that pane
      if (overData?.type === 'tabbar') {
        const targetPaneId = overData.paneId as string;
        if (sourcePaneId !== targetPaneId) {
          state.moveTabToPane(draggedTabId, sourcePaneId, targetPaneId);
        }
        return;
      }

      // Case 3: Drop on another sortable tab
      if (overData?.type === 'tab') {
        const overTabId = overData.tabId as string;
        const overPaneId = overData.paneId as string;

        if (sourcePaneId === overPaneId) {
          const pane = panes.find((p) => p.id === sourcePaneId);
          if (!pane) return;

          const fromIndex = pane.tabs.findIndex((t) => t.id === draggedTabId);
          const toIndex = pane.tabs.findIndex((t) => t.id === overTabId);

          if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
            state.reorderTabInPane(sourcePaneId, fromIndex, toIndex);
          }
        } else {
          const targetPane = panes.find((p) => p.id === overPaneId);
          if (!targetPane) return;

          const insertIndex = targetPane.tabs.findIndex((t) => t.id === overTabId);
          state.moveTabToPane(draggedTabId, sourcePaneId, overPaneId, insertIndex);
        }
      }
    },
    [panes]
  );

  return (
    <div
      className="flex h-screen flex-col bg-claude-dark-bg text-claude-dark-text"
      style={
        { '--macos-traffic-light-padding-left': `${trafficLightPadding}px` } as React.CSSProperties
      }
    >
      <CustomTitleBar />
      <UpdateBanner />
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <TabBarRow />
        <div className="flex flex-1 overflow-hidden">
          {/* Command Palette (Cmd+K) */}
          <CommandPalette />

          {/* Sidebar - Task list / Sessions (280px) */}
          <Sidebar />

          {/* Content column: floating actions bar + pane content */}
          <div
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
            style={{ background: 'transparent' }}
          >
            {/* Content header with action buttons — floats over pane content */}
            <div
              className="absolute right-0 top-0 z-10 flex items-center justify-end pr-2"
              style={{
                height: '36px',
                left: 0,
                backgroundColor: 'rgba(20, 20, 22, 0.45)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <TabBarActions />
            </div>

            {/* Multi-pane content area — renders from top:0, behind the floating bar */}
            <PaneContainer />
          </div>
        </div>

        {/* Drag overlay - semi-transparent ghost of the dragged tab */}
        <DragOverlay dropAnimation={null}>
          {activeTab ? <DragOverlayTab tab={activeTab} /> : null}
        </DragOverlay>
      </DndContext>
      <GlobalTaskDetailDialog />
      <UpdateDialog />
      <WorkspaceIndicator />
    </div>
  );
};
