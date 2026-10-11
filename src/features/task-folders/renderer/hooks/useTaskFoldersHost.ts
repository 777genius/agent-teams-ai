import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { clearTaskManualUnread, markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { sortTasksByFreshness } from '@renderer/utils/taskGrouping';

import { moveRequest } from '../adapters/moveRequest';
import { folderController, panelController } from '../composition';
import { projectFolders } from '../view-models/projection';

import type { RefObject } from 'react';
export function useTaskFoldersHost(sidebar: RefObject<HTMLDivElement | null>, collapsed: boolean) {
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
