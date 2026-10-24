import { useStore } from '@renderer/store';
import { isTaskDetailTab } from '@renderer/types/tabs';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import { taskDetailKey } from '../../core';

import type { Tab } from '@renderer/types/tabs';

/** Derive the visible label from the same accepted full DTO as the task page. */
export function useTaskDetailTabLabel(tab: Tab): string {
  return useStore((state) => {
    if (!isTaskDetailTab(tab) || !tab.taskDetail || !tab.teamName) return tab.label;
    const { contextId, taskId } = tab.taskDetail;
    if (state.activeContextId !== contextId) return tab.label;
    const full =
      state.taskDetailById[taskDetailKey({ contextId, teamName: tab.teamName, taskId })]?.full;
    const task = full?.id === taskId ? full : null;
    const team = state.teamByName[tab.teamName]?.displayName?.trim() || tab.teamName;
    const number = task ? formatTaskDisplayLabel(task) : `#${deriveTaskDisplayId(taskId)}`;
    return `${team} ${number}${task?.subject ? ` ${task.subject}` : ''}`;
  });
}
