import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { clearTaskManualUnread, markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { sortTasksByFreshness } from '@renderer/utils/taskGrouping';

import { moveRequest } from '../adapters/moveRequest';
import { folderController, panelController } from '../composition';
import { projectFolders } from '../view-models/projection';

import type { RefObject } from 'react';
export function useTaskFoldersHost(
  sidebar: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  panelRef: RefObject<HTMLDivElement | null>
) {
  const panelObserverCleanup = useRef<(() => void) | null>(null);
  const state = useSyncExternalStore(folderController.subscribe, folderController.getSnapshot);
  const panel = useSyncExternalStore(panelController.subscribe, panelController.getSnapshot);
  const move = useSyncExternalStore(moveRequest.subscribe, moveRequest.getSnapshot);
  const tasks = useStore((s) => s.globalTasks);
  const openDetail = useStore((s) => s.openGlobalTaskDetail);
  const local = useTaskLocalState();
  const [showArchived, setShowArchived] = useState(true);
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    height: number;
    width: number;
  } | null>(null);
  const projection = useMemo(
    () =>
      projectFolders(
        state.snapshot,
        sortTasksByFreshness(tasks),
        local.isArchived,
        local.getRenamedSubject,
        showArchived
      ),
    [state.snapshot, tasks, local, showArchived]
  );
  useEffect(() => {
    void folderController.load();
  }, []);
  useEffect(() => {
    folderController.setCatalog(
      tasks.map((task) => ({ teamName: task.teamName, taskId: task.id }))
    );
  }, [tasks]);
  useEffect(() => {
    const source = panelController.getSnapshot().dragSource;
    if (
      source?.startsWith('task:') &&
      !tasks.some((task) => `task:${JSON.stringify([task.teamName, task.id])}` === source)
    )
      panelController.end();
  }, [tasks]);
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
      panelController.dispose();
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
      panelController.dispose();
    };
  }, []);
  return {
    state,
    panel,
    move,
    projection,
    local,
    rect,
    registerPanel,
    showArchived,
    setShowArchived,
    openTask: (team: string, id: string): void => {
      clearTaskManualUnread(team, id);
      openDetail(team, id);
    },
    markUnread: markTaskUnread,
  };
}
export type TaskFoldersHostModel = ReturnType<typeof useTaskFoldersHost>;
