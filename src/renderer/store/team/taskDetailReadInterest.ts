import {
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
  taskDetailKey,
} from '@features/team-task-detail/core';
import { isTaskDetailTab } from '@renderer/types/tabs';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';
import type { Pane } from '@renderer/types/panes';

export interface TaskDetailReadInterestSources {
  activeContextId: string;
  isContextSwitching?: boolean;
  paneLayout: { panes: readonly Pane[] };
  taskDetailSurfaceInterests: Readonly<Record<string, TaskDetailIdentity | null>>;
}

export interface TaskDetailReadDemand {
  key: string;
  contextId: string;
  teamName: string;
  taskId: string;
  needsRead: boolean;
}

function addIdentity(
  identities: Map<string, TaskDetailIdentity>,
  rawIdentity: TaskDetailIdentity,
  activeContextId: string
): void {
  const identity = normalizeTaskDetailIdentity(rawIdentity);
  if (
    identity.contextId !== activeContextId ||
    !isValidTaskDetailIdentity(identity) ||
    identities.has(taskDetailKey(identity))
  )
    return;
  identities.set(taskDetailKey(identity), identity);
}

export function selectTaskDetailReadIdentities(
  state: TaskDetailReadInterestSources
): TaskDetailIdentity[] {
  if (state.isContextSwitching) return [];
  const identities = new Map<string, TaskDetailIdentity>();
  for (const pane of state.paneLayout.panes) {
    for (const tab of pane.tabs) {
      if (!isTaskDetailTab(tab) || !tab.taskDetail || !tab.teamName) continue;
      addIdentity(
        identities,
        {
          contextId: tab.taskDetail.contextId,
          teamName: tab.teamName,
          taskId: tab.taskDetail.taskId,
        },
        state.activeContextId
      );
    }
  }
  for (const identity of Object.values(state.taskDetailSurfaceInterests)) {
    if (identity) addIdentity(identities, identity, state.activeContextId);
  }
  return [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

export function hasTaskDetailReadInterest(
  state: TaskDetailReadInterestSources,
  identity: TaskDetailIdentity
): boolean {
  const key = taskDetailKey(identity);
  return selectTaskDetailReadIdentities(state).some(
    (candidate) => taskDetailKey(candidate) === key
  );
}

export function selectTaskDetailReadDemands(
  state: TaskDetailReadInterestSources & {
    taskDetailById: Readonly<Record<string, { loading: boolean; refreshPending: boolean }>>;
  }
): TaskDetailReadDemand[] {
  return selectTaskDetailReadIdentities(state).map((identity) => {
    const key = taskDetailKey(identity);
    const entry = state.taskDetailById[key];
    return {
      key,
      contextId: identity.contextId,
      teamName: identity.teamName,
      taskId: identity.taskId,
      needsRead: !entry || (entry.refreshPending && !entry.loading),
    };
  });
}
