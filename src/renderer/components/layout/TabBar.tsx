/**
 * TabBar - Displays open tabs with close buttons and action buttons.
 * Accepts a paneId prop to scope to a specific pane's tabs.
 * Supports tab switching, closing, horizontal scrolling on overflow,
 * right-click context menu, middle-click to close, Shift/Ctrl+click multi-select,
 * and drag-and-drop reordering/cross-pane movement via @dnd-kit.
 * When sidebar is collapsed, shows expand button on the left with macOS traffic light spacing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SortableTab } from './SortableTab';
import { TabContextMenu } from './TabContextMenu';

interface TabBarProps {
  paneId: string;
}

export const TabBar = ({ paneId }: TabBarProps): React.JSX.Element => {
  const {
    pane,
    isFocused,
    paneCount,
    setActiveTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabs,
    setSelectedTabIds,
    clearTabSelection,
    fetchSessionDetail,
    fetchSessions,
    splitPane,
    togglePinSession,
    pinnedSessionIds,
    toggleHideSession,
    hiddenSessionIds,
  } = useStore(
    useShallow((s) => ({
      pane: s.paneLayout.panes.find((p) => p.id === paneId),
      isFocused: s.paneLayout.focusedPaneId === paneId,
      paneCount: s.paneLayout.panes.length,
      setActiveTab: s.setActiveTab,
      closeTab: s.closeTab,
      closeOtherTabs: s.closeOtherTabs,
      closeAllTabs: s.closeAllTabs,
      closeTabs: s.closeTabs,
      setSelectedTabIds: s.setSelectedTabIds,
      clearTabSelection: s.clearTabSelection,
      fetchSessionDetail: s.fetchSessionDetail,
      fetchSessions: s.fetchSessions,
      splitPane: s.splitPane,
      togglePinSession: s.togglePinSession,
      pinnedSessionIds: s.pinnedSessionIds,
      toggleHideSession: s.toggleHideSession,
      hiddenSessionIds: s.hiddenSessionIds,
    }))
  );

  const openTabs = useMemo(() => pane?.tabs ?? [], [pane?.tabs]);
  const activeTabId = pane?.activeTabId ?? null;
  const selectedTabIds = useMemo(() => pane?.selectedTabIds ?? [], [pane?.selectedTabIds]);

  // Derive Set for O(1) lookups
  const selectedSet = useMemo(() => new Set(selectedTabIds), [selectedTabIds]);

  // Derive stable tab IDs array for SortableContext
  const tabIds = useMemo(() => openTabs.map((t) => t.id), [openTabs]);

  // Hover states for buttons
  const [refreshHover, setRefreshHover] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null
  );

  // Track last clicked tab for Shift range selection
  const lastClickedTabIdRef = useRef<string | null>(null);

  // Get the active tab for refresh button
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);

  // Refs for auto-scrolling to active tab
  const tabRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Make the tab bar area droppable for cross-pane drops
  const { setNodeRef: setDroppableRef, isOver: isDroppableOver } = useDroppable({
    id: `tabbar-${paneId}`,
    data: {
      type: 'tabbar',
      paneId,
    },
  });

  // Auto-scroll to active tab when it changes
  useEffect(() => {
    if (!activeTabId) return;

    const tabElement = tabRefsMap.current.get(activeTabId);
    if (tabElement && scrollContainerRef.current) {
      tabElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeTabId]);

  // Clear selection on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selectedTabIds.length > 0) {
        clearTabSelection();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedTabIds.length, clearTabSelection]);

  // Handle tab click with multi-select support
  const handleTabClick = useCallback(
    (tabId: string, e: React.MouseEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMeta) {
        // Ctrl/Cmd+click: toggle tab in selection
        if (selectedSet.has(tabId)) {
          setSelectedTabIds(selectedTabIds.filter((id) => id !== tabId));
        } else {
          setSelectedTabIds([...selectedTabIds, tabId]);
        }
        lastClickedTabIdRef.current = tabId;
        return;
      }

      if (isShift && lastClickedTabIdRef.current) {
        // Shift+click: range selection from last clicked to current
        const lastIndex = openTabs.findIndex((t) => t.id === lastClickedTabIdRef.current);
        const currentIndex = openTabs.findIndex((t) => t.id === tabId);
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = openTabs.slice(start, end + 1).map((t) => t.id);
          // Merge with existing selection
          const merged = new Set([...selectedTabIds, ...rangeIds]);
          setSelectedTabIds([...merged]);
        }
        return;
      }

      // Plain click: clear selection, switch tab
      clearTabSelection();
      lastClickedTabIdRef.current = tabId;
      setActiveTab(tabId);
    },
    [openTabs, selectedTabIds, selectedSet, setActiveTab, setSelectedTabIds, clearTabSelection]
  );

  // Middle-click to close + prevent text selection on Shift/Cmd click
  const handleMouseDown = useCallback(
    (tabId: string, e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tabId);
        return;
      }
      // Prevent native text selection when Shift or Cmd/Ctrl clicking tabs
      if (e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
      }
    },
    [closeTab]
  );

  // Right-click context menu
  const handleContextMenu = useCallback((tabId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  // Handle refresh for active session tab
  const handleRefresh = async (): Promise<void> => {
    if (activeTab?.type === 'session' && activeTab.projectId && activeTab.sessionId) {
      await Promise.all([
        fetchSessionDetail(activeTab.projectId, activeTab.sessionId, activeTabId ?? undefined),
        fetchSessions(activeTab.projectId),
      ]);
    }
  };

  // Ref setter for SortableTab
  const setTabRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) {
      tabRefsMap.current.set(tabId, el);
    } else {
      tabRefsMap.current.delete(tabId);
    }
  }, []);

  // Context menu helpers
  const contextMenuTabId = contextMenu?.tabId ?? null;
  const effectiveSelectedCount =
    contextMenuTabId && selectedSet.has(contextMenuTabId) ? selectedTabIds.length : 0;

  // Pin state for context menu tab
  const contextMenuTab = contextMenuTabId ? openTabs.find((t) => t.id === contextMenuTabId) : null;
  const isContextMenuTabSession = contextMenuTab?.type === 'session';
  const isContextMenuTabPinned =
    isContextMenuTabSession && contextMenuTab?.sessionId
      ? pinnedSessionIds.includes(contextMenuTab.sessionId)
      : false;
  const isContextMenuTabHidden =
    isContextMenuTabSession && contextMenuTab?.sessionId
      ? hiddenSessionIds.includes(contextMenuTab.sessionId)
      : false;

  // Detect macOS Electron for traffic lights padding
  const isMacElectron =
    isElectronMode() && window.navigator.userAgent.toLowerCase().includes('mac');

  // Show sidebar expand button only in the leftmost pane
  const isLeftmostPane = useStore(
    (s) => s.paneLayout.panes.length === 0 || s.paneLayout.panes[0]?.id === paneId
  );

  return (
    <div
      className="flex h-full items-end pr-2"
      style={
        {
          paddingLeft:
            isMacElectron && isLeftmostPane
              ? 'var(--macos-traffic-light-padding-left, 72px)'
              : '8px',
          WebkitAppRegion: isMacElectron ? 'drag' : 'no-drag',
          opacity: isFocused || paneCount === 1 ? 1 : 0.7,
        } as React.CSSProperties
      }
    >
      <div
        className="flex min-w-0 shrink items-center gap-1"
        style={
          {
            WebkitAppRegion: 'no-drag',
            flex: '0 1 auto',
            maxWidth: 'calc(100% - 32px)',
          } as React.CSSProperties
        }
      >
        {/* Keep the sortable list inside a no-drag group so tabs remain clickable,
            while any leftover space in the pane segment can drag the window. */}
        <div
          ref={(el) => {
            scrollContainerRef.current = el;
            setDroppableRef(el);
          }}
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-1"
          style={{
            outline: isDroppableOver ? '1px dashed var(--color-accent, #6366f1)' : 'none',
            outlineOffset: '-1px',
            overflowX: 'auto',
            overflowY: 'hidden',
          }}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            {openTabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                paneId={paneId}
                isActive={tab.id === activeTabId}
                isSelected={selectedSet.has(tab.id)}
                onTabClick={handleTabClick}
                onMouseDown={handleMouseDown}
                onContextMenu={handleContextMenu}
                onClose={closeTab}
                setRef={setTabRef}
              />
            ))}
          </SortableContext>
        </div>

        {/* Refresh button - show only for session tabs */}
        {activeTab?.type === 'session' && (
          <button
            className="flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
            style={{
              color: refreshHover ? 'var(--color-text)' : 'var(--color-text-muted)',
              backgroundColor: refreshHover ? 'var(--color-surface-raised)' : 'transparent',
            }}
            onMouseEnter={() => setRefreshHover(true)}
            onMouseLeave={() => setRefreshHover(false)}
            onClick={handleRefresh}
            title={`Refresh Session (${formatShortcut('R')})`}
          >
            <RefreshCw className="size-4" />
          </button>
        )}
      </div>

      {/* Guaranteed drag target, even when the tab list is dense. */}
      <div className="min-w-8 flex-1 self-stretch" />

      {/* Context menu */}
      {contextMenu && contextMenuTabId && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tabId={contextMenuTabId}
          paneId={paneId}
          selectedCount={effectiveSelectedCount}
          onClose={() => setContextMenu(null)}
          onCloseTab={() => closeTab(contextMenuTabId)}
          onCloseOtherTabs={() => closeOtherTabs(contextMenuTabId)}
          onCloseAllTabs={() => closeAllTabs()}
          onCloseSelectedTabs={
            effectiveSelectedCount > 1 ? () => closeTabs([...selectedTabIds]) : undefined
          }
          onSplitRight={() => splitPane(paneId, contextMenuTabId, 'right')}
          onSplitLeft={() => splitPane(paneId, contextMenuTabId, 'left')}
          disableSplit={paneCount >= 4}
          isSessionTab={isContextMenuTabSession}
          isPinned={isContextMenuTabPinned}
          onTogglePin={
            isContextMenuTabSession && contextMenuTab?.sessionId
              ? () => togglePinSession(contextMenuTab.sessionId!)
              : undefined
          }
          isHidden={isContextMenuTabHidden}
          onToggleHide={
            isContextMenuTabSession && contextMenuTab?.sessionId
              ? () => toggleHideSession(contextMenuTab.sessionId!)
              : undefined
          }
        />
      )}
    </div>
  );
};
