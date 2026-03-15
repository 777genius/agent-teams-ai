/**
 * Sidebar - Navigation with task list and session list.
 *
 * Structure:
 * - Tab bar: Collapse button + Tasks | Sessions
 * - Scrollable Body: Task list or date-grouped session list
 * - Resizable: Drag right edge to resize
 * - Collapsible: Cmd+B to toggle (Notion-style)
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { PanelLeft } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { DateGroupedSessions } from '../sidebar/DateGroupedSessions';
import { GlobalTaskList } from '../sidebar/GlobalTaskList';
import { defaultTaskFiltersState } from '../sidebar/taskFiltersState';

import type { TaskFiltersState } from '../sidebar/taskFiltersState';

type SidebarTab = 'tasks' | 'sessions';

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 280;

export const Sidebar = (): React.JSX.Element => {
  const { sidebarCollapsed, toggleSidebar } = useStore(
    useShallow((s) => ({
      sidebarCollapsed: s.sidebarCollapsed,
      toggleSidebar: s.toggleSidebar,
    }))
  );
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('tasks');
  const [taskFilters, setTaskFilters] = useState<TaskFiltersState>(defaultTaskFiltersState);
  const [taskFiltersPopoverOpen, setTaskFiltersPopoverOpen] = useState(false);
  const [isCollapseHovered, setIsCollapseHovered] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Handle mouse move during resize (right sidebar: width = viewport - clientX)
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setWidth(newWidth);
      }
    },
    [isResizing]
  );

  // Handle mouse up to stop resizing
  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add/remove event listeners for resize
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    setIsResizing(true);
  };

  return (
    <div
      ref={sidebarRef}
      className="relative flex shrink-0 flex-col overflow-hidden border-l"
      style={{
        backgroundColor: 'var(--color-surface-sidebar)',
        borderColor: 'var(--color-border)',
        width: sidebarCollapsed ? 0 : width,
        minWidth: sidebarCollapsed ? 0 : undefined,
        borderLeftWidth: sidebarCollapsed ? 0 : undefined,
        transition: 'width 0.22s ease-out, border-width 0.22s ease-out',
      }}
    >
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden pl-2"
        style={{
          width: '100%',
          minWidth: sidebarCollapsed ? 0 : width,
        }}
      >
        {/* Tab bar: Collapse button + Tasks | Sessions */}
        <div
          className="flex shrink-0 items-end gap-2 border-b px-3 pt-1"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {/* Collapse sidebar button */}
          <button
            onClick={toggleSidebar}
            onMouseEnter={() => setIsCollapseHovered(true)}
            onMouseLeave={() => setIsCollapseHovered(false)}
            className="mb-1 shrink-0 rounded-md p-1 transition-colors"
            style={{
              color: isCollapseHovered ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
              backgroundColor: isCollapseHovered ? 'var(--color-surface-raised)' : 'transparent',
            }}
            title={`Collapse sidebar (${formatShortcut('B')})`}
          >
            <PanelLeft className="size-3.5" />
          </button>

          <div className="flex-1" />
          <div className="flex" role="tablist" aria-label="Sidebar view">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'tasks'}
              aria-controls="sidebar-tasks-panel"
              id="sidebar-tab-tasks"
              className={`relative px-3 py-1.5 text-[11px] font-medium transition-colors ${
                sidebarTab === 'tasks' ? 'text-text' : 'text-text-muted hover:text-text-secondary'
              }`}
              style={
                sidebarTab === 'tasks'
                  ? {
                      borderBottom: '2px solid var(--color-text)',
                      marginBottom: '-1px',
                    }
                  : undefined
              }
              onClick={() => setSidebarTab('tasks')}
            >
              Tasks
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'sessions'}
              aria-controls="sidebar-sessions-panel"
              id="sidebar-tab-sessions"
              className={`relative px-3 py-1.5 text-[11px] font-medium transition-colors ${
                sidebarTab === 'sessions'
                  ? 'text-text'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              style={
                sidebarTab === 'sessions'
                  ? {
                      borderBottom: '2px solid var(--color-text)',
                      marginBottom: '-1px',
                    }
                  : undefined
              }
              onClick={() => setSidebarTab('sessions')}
            >
              Sessions
            </button>
          </div>
          <div className="flex-1" />
        </div>

        {/* Content: Tasks list or Sessions list */}
        <div
          id="sidebar-tasks-panel"
          role="tabpanel"
          aria-labelledby="sidebar-tab-tasks"
          hidden={sidebarTab !== 'tasks'}
          className="min-w-0 flex-1 overflow-hidden"
        >
          <GlobalTaskList
            hideHeader
            filters={taskFilters}
            onFiltersChange={setTaskFilters}
            filtersPopoverOpen={taskFiltersPopoverOpen}
            onFiltersPopoverOpenChange={setTaskFiltersPopoverOpen}
          />
        </div>
        <div
          id="sidebar-sessions-panel"
          role="tabpanel"
          aria-labelledby="sidebar-tab-sessions"
          hidden={sidebarTab !== 'sessions'}
          className="min-w-0 flex-1 overflow-hidden"
        >
          <DateGroupedSessions />
        </div>
      </div>

      {/* Resize handle - only interactive when expanded */}
      {!sidebarCollapsed && (
        <button
          type="button"
          aria-label="Resize sidebar"
          className={`absolute left-0 top-0 h-full w-1 cursor-col-resize border-0 bg-transparent p-0 transition-colors hover:bg-blue-500/50 ${
            isResizing ? 'bg-blue-500/50' : ''
          }`}
          onMouseDown={handleResizeStart}
        />
      )}
    </div>
  );
};
