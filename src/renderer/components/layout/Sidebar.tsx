/**
 * Sidebar - Breadcrumb-style navigation with project/worktree hierarchy.
 *
 * Structure:
 * - Fixed Header: Project selector (Row 1) + Worktree selector (Row 2, conditional)
 * - Tab bar: Tasks | Sessions
 * - Scrollable Body: Task list or date-grouped session list
 * - Resizable: Drag right edge to resize
 * - Collapsible: Cmd+B to toggle (Notion-style)
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { DateGroupedSessions } from '../sidebar/DateGroupedSessions';
import { GlobalTaskList } from '../sidebar/GlobalTaskList';
import { TaskFiltersPopover } from '../sidebar/TaskFiltersPopover';
import { defaultTaskFiltersState } from '../sidebar/taskFiltersState';

import { SidebarHeader } from './SidebarHeader';

import type { TaskFiltersState } from '../sidebar/taskFiltersState';

type SidebarTab = 'tasks' | 'sessions';

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 280;

export const Sidebar = (): React.JSX.Element => {
  const { projects, projectsLoading, fetchProjects, sidebarCollapsed, teams } = useStore(
    useShallow((s) => ({
      projects: s.projects,
      projectsLoading: s.projectsLoading,
      fetchProjects: s.fetchProjects,
      sidebarCollapsed: s.sidebarCollapsed,
      teams: s.teams,
    }))
  );
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('tasks');
  const [taskFilters, setTaskFilters] = useState<TaskFiltersState>(defaultTaskFiltersState);
  const [taskFiltersPopoverOpen, setTaskFiltersPopoverOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Fetch projects on mount if not loaded
  useEffect(() => {
    if (projects.length === 0 && !projectsLoading) {
      void fetchProjects();
    }
  }, [projects.length, projectsLoading, fetchProjects]);

  // Handle mouse move during resize
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = e.clientX;
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
      className="relative flex shrink-0 flex-col overflow-hidden border-r"
      style={{
        backgroundColor: 'var(--color-surface-sidebar)',
        borderColor: 'var(--color-border)',
        width: sidebarCollapsed ? 0 : width,
        minWidth: sidebarCollapsed ? 0 : undefined,
        borderRightWidth: sidebarCollapsed ? 0 : undefined,
        transition: 'width 0.22s ease-out, border-width 0.22s ease-out',
      }}
    >
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden pr-2"
        style={{
          width: '100%',
          minWidth: sidebarCollapsed ? 0 : width,
        }}
      >
        <SidebarHeader />

        {/* Tab bar: Tasks | Sessions */}
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="flex gap-0.5">
            <button
              type="button"
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                sidebarTab === 'tasks'
                  ? 'bg-surface-raised text-text'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              onClick={() => setSidebarTab('tasks')}
            >
              Tasks
            </button>
            <button
              type="button"
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                sidebarTab === 'sessions'
                  ? 'bg-surface-raised text-text'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              onClick={() => setSidebarTab('sessions')}
            >
              Sessions
            </button>
          </div>
          {sidebarTab === 'tasks' && (
            <TaskFiltersPopover
              open={taskFiltersPopoverOpen}
              onOpenChange={setTaskFiltersPopoverOpen}
              teams={teams.map((t) => ({ teamName: t.teamName, displayName: t.displayName }))}
              filters={taskFilters}
              onFiltersChange={setTaskFilters}
              onApply={() => {}}
            />
          )}
        </div>

        {/* Content: Tasks list or Sessions list */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {sidebarTab === 'tasks' ? (
            <GlobalTaskList
              hideHeader
              filters={taskFilters}
              onFiltersChange={setTaskFilters}
              filtersPopoverOpen={taskFiltersPopoverOpen}
              onFiltersPopoverOpenChange={setTaskFiltersPopoverOpen}
            />
          ) : (
            <DateGroupedSessions />
          )}
        </div>
      </div>

      {/* Resize handle - only interactive when expanded */}
      {!sidebarCollapsed && (
        <button
          type="button"
          aria-label="Resize sidebar"
          className={`absolute right-0 top-0 h-full w-1 cursor-col-resize border-0 bg-transparent p-0 transition-colors hover:bg-blue-500/50 ${
            isResizing ? 'bg-blue-500/50' : ''
          }`}
          onMouseDown={handleResizeStart}
        />
      )}
    </div>
  );
};
