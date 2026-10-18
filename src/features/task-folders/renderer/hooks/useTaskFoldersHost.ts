import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { buildTaskFilterTeamOptions } from '@renderer/components/sidebar/taskFilterOptions';
import {
  getTaskUnreadCount,
  useReadStateSnapshot,
} from '@renderer/components/sidebar/taskFiltersState';
import {
  createTaskEffectiveSubjectAccessor,
  filterGlobalTasks,
  sortGlobalTasks,
} from '@renderer/components/sidebar/taskViewPolicy';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { useTaskProjectFilterOptions } from '@renderer/hooks/useTaskProjectFilterOptions';
import { useTaskTeamStatus } from '@renderer/hooks/useTaskTeamStatus';
import { clearTaskManualUnread, markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import { moveRequest } from '../adapters/moveRequest';
import { folderController, panelController } from '../composition';
import { projectFolders } from '../view-models/projection';
import { applyVisibleTaskChildren } from '../view-models/projectionView';
import { countUnreadTasksByNode } from '../view-models/taskUnreadCounts';

import { useTaskViewState } from './useTaskViewState';

import type { RefObject } from 'react';
export function useTaskFoldersHost(
  contextId: string,
  sidebar: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  panelRef: RefObject<HTMLDivElement | null>
) {
  const panelObserverCleanup = useRef<(() => void) | null>(null);
  const state = useSyncExternalStore(folderController.subscribe, folderController.getSnapshot);
  const panel = useSyncExternalStore(panelController.subscribe, panelController.getSnapshot);
  const move = useSyncExternalStore(moveRequest.subscribe, moveRequest.getSnapshot);
  const tasks = useStore((s) => s.globalTasks);
  const globalDeletedTasks = useStore((s) => s.globalDeletedTasks);
  const fetchAllDeletedTasks = useStore((s) => s.fetchAllDeletedTasks);
  const restoreTask = useStore((s) => s.restoreTask);
  const fetchAllTasks = useStore((s) => s.fetchAllTasks);
  const teams = useStore((s) => s.teams);
  const teamByName = useStore((s) => s.teamByName);
  const isTeamOffline = useTaskTeamStatus();
  const openDetail = useStore((s) => s.openGlobalTaskDetail);
  const local = useTaskLocalState();
  const readState = useReadStateSnapshot();
  const view = useTaskViewState('tree');
  const taskOrder = view.sortMode === 'manual' ? 'manual' : 'computed';
  const viewSetSortOpen = view.setSortOpen;
  const viewSetFiltersOpen = view.setFiltersOpen;
  const viewClosePopovers = view.closePopovers;
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    height: number;
    width: number;
  } | null>(null);
  const viewTasks = useMemo(
    () => (globalDeletedTasks.length > 0 ? [...tasks, ...globalDeletedTasks] : tasks),
    [globalDeletedTasks, tasks]
  );
  useEffect(() => {
    if (view.filters.showDeleted) void fetchAllDeletedTasks();
  }, [fetchAllDeletedTasks, view.filters.showDeleted]);
  const canonicalProjection = useMemo(
    () =>
      projectFolders(
        state.snapshot,
        sortGlobalTasks(viewTasks, 'time', contextId),
        local.isArchived,
        local.getRenamedSubject,
        true
      ),
    [state.snapshot, viewTasks, local, contextId]
  );
  const unreadTaskCounts = useMemo(
    () =>
      countUnreadTasksByNode(
        canonicalProjection,
        (task) =>
          getTaskUnreadCount(
            readState,
            { contextId, teamName: task.teamName, taskId: task.id },
            task.comments
          ) > 0
      ),
    [canonicalProjection, contextId, readState]
  );
  const getEffectiveSubject = useMemo(
    () =>
      createTaskEffectiveSubjectAccessor((task) => local.getRenamedSubject(task.teamName, task.id)),
    [local]
  );
  const projection = useMemo(() => {
    const visibleTasks = filterGlobalTasks(
      viewTasks,
      {
        contextId,
        filters: view.filters,
        searchQuery: view.searchQuery,
        archiveMode: view.filters.showArchived ? 'all' : 'active',
        getEffectiveSubject,
      },
      readState,
      (task) => local.isArchived(task.teamName, task.id)
    );
    const visibleTaskKeys = new Set(
      visibleTasks.map((task) => `task:${JSON.stringify([task.teamName, task.id])}`)
    );
    return applyVisibleTaskChildren(
      canonicalProjection,
      viewTasks,
      (task) => visibleTaskKeys.has(`task:${JSON.stringify([task.teamName, task.id])}`),
      (siblings) =>
        view.sortMode === 'manual'
          ? [...siblings]
          : sortGlobalTasks(siblings, view.sortMode, contextId, readState),
      taskOrder
    );
  }, [
    canonicalProjection,
    contextId,
    getEffectiveSubject,
    local,
    readState,
    taskOrder,
    viewTasks,
    view.filters,
    view.searchQuery,
    view.sortMode,
  ]);
  const projectFilterOptions = useTaskProjectFilterOptions(view.filtersOpen);
  const taskFilterTeams = useMemo(() => buildTaskFilterTeamOptions(teams), [teams]);
  const getOwnerColorName = useCallback(
    (task: { teamName: string; owner?: string }): string | null | undefined => {
      if (!task.owner) return null;
      const members = teamByName[task.teamName]?.members;
      return members ? (buildMemberColorMap(members).get(task.owner) ?? null) : undefined;
    },
    [teamByName]
  );
  const setViewSortOpen = useCallback(
    (open: boolean) => {
      viewSetSortOpen(open);
      panelController.hold('menu:task-view-sort', open);
    },
    [viewSetSortOpen]
  );
  const setViewFiltersOpen = useCallback(
    (open: boolean) => {
      viewSetFiltersOpen(open);
      panelController.hold('menu:task-view-filters', open);
    },
    [viewSetFiltersOpen]
  );
  const closeViewControls = useCallback(() => {
    viewClosePopovers();
    panelController.hold('menu:task-view-sort', false);
    panelController.hold('menu:task-view-filters', false);
  }, [viewClosePopovers]);
  useEffect(() => {
    if (collapsed || !panel.open) closeViewControls();
  }, [closeViewControls, collapsed, panel.open]);
  useEffect(() => () => closeViewControls(), [closeViewControls]);
  useEffect(() => {
    void folderController.load();
  }, []);
  useEffect(() => {
    folderController.setCatalog(
      viewTasks.map((task) => ({ teamName: task.teamName, taskId: task.id }))
    );
  }, [viewTasks]);
  useEffect(() => {
    const source = panelController.getSnapshot().dragSource;
    if (
      source?.startsWith('task:') &&
      !viewTasks.some((task) => `task:${JSON.stringify([task.teamName, task.id])}` === source)
    )
      panelController.end();
  }, [viewTasks]);
  const registerPanel = useCallback(
    (element: HTMLDivElement | null) => {
      panelRef.current = element;
      panelObserverCleanup.current?.();
      panelObserverCleanup.current = null;
      if (!element) {
        if (document.activeElement === document.body) panelController.hold('focus', false);
        return;
      }
      let lastFocused: HTMLElement | null = null;
      const reconcileFocus = (records: MutationRecord[] = []): void => {
        const descendantUnmounted =
          records.some((record) => record.removedNodes.length > 0) ||
          (!!lastFocused && !lastFocused.isConnected);
        if (descendantUnmounted && !element.contains(document.activeElement))
          panelController.hold('focus', false);
      };
      const rememberFocus = (event: FocusEvent): void => {
        const target = event.target as Node | null;
        if (target && element.contains(target)) lastFocused = target as HTMLElement;
        queueMicrotask(() => {
          const active = document.activeElement;
          if (active && element.contains(active)) lastFocused = active as HTMLElement;
          else reconcileFocus();
        });
      };
      const reconcileAfterEvent = (): void => queueMicrotask(() => reconcileFocus());
      const observer = new MutationObserver(reconcileFocus);
      observer.observe(element, { childList: true, subtree: true });
      document.addEventListener('focus', rememberFocus, true);
      document.addEventListener('focusin', rememberFocus, true);
      document.addEventListener('focusout', reconcileAfterEvent, true);
      document.addEventListener('keydown', reconcileAfterEvent, true);
      panelObserverCleanup.current = () => {
        observer.disconnect();
        document.removeEventListener('focus', rememberFocus, true);
        document.removeEventListener('focusin', rememberFocus, true);
        document.removeEventListener('focusout', reconcileAfterEvent, true);
        document.removeEventListener('keydown', reconcileAfterEvent, true);
      };
      reconcileFocus();
    },
    [panelRef]
  );
  useEffect(() => () => panelObserverCleanup.current?.(), []);
  useEffect(() => {
    if (collapsed) {
      panelController.suspend();
      return;
    }
    const element = sidebar.current;
    if (!element) return;
    const measure = (): void => {
      const r = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(300, r.left));
      setRect({ left: r.left - width, top: r.top, height: r.height, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sidebar, collapsed]);
  useEffect(() => {
    const end = (): void => panelController.end();
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('blur', end);
      panelController.suspend();
    };
  }, []);
  return {
    contextId,
    state,
    panel,
    move,
    projection,
    canonicalProjection,
    unreadTaskCounts,
    view: {
      ...view,
      setSortOpen: setViewSortOpen,
      setFiltersOpen: setViewFiltersOpen,
    },
    closeViewControls,
    projectFilterOptions,
    taskFilterTeams,
    getOwnerColorName,
    isTeamOffline,
    local,
    rect,
    registerPanel,
    openTask: (team: string, id: string): void => {
      clearTaskManualUnread({ contextId, teamName: team, taskId: id });
      openDetail(team, id);
    },
    markUnread: (team: string, id: string): void => {
      markTaskUnread({ contextId, teamName: team, taskId: id });
    },
    restoreTask: (team: string, id: string): void => {
      void (async () => {
        try {
          await restoreTask(team, id);
          await fetchAllTasks();
        } catch {
          // error via store
        }
      })();
    },
  };
}
export type TaskFoldersHostModel = ReturnType<typeof useTaskFoldersHost>;
