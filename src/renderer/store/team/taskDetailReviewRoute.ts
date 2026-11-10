import {
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
} from '@features/team-task-detail/core';
import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
} from './taskDetailReadAuthority';

import type { AppState } from '../types';
import type { TaskDetailIdentity, TaskDetailReadScope } from '@features/team-task-detail/core';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';

export interface TaskDetailReviewRequest extends TaskDetailReadScope {
  nonce: string;
  targetTeamTabId: string;
  taskId: string;
  filePath?: string;
  requestOptions: TaskChangeRequestOptions;
  status: 'pending' | 'opening' | 'blocked';
}

export function queueTaskDetailReview(
  get: () => AppState,
  rawIdentity: TaskDetailIdentity,
  options: Pick<TaskDetailReviewRequest, 'filePath' | 'requestOptions'>
): boolean {
  const identity = normalizeTaskDetailIdentity(rawIdentity);
  const before = get();
  if (
    !isValidTaskDetailIdentity(identity) ||
    before.isContextSwitching ||
    before.activeContextId !== identity.contextId
  )
    return false;
  const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
  before.openTeamTab(identity.teamName);
  const state = get();
  if (
    state.isContextSwitching ||
    !isTaskDetailReadScopeCurrent(scope, state.activeContextId, identity.teamName)
  )
    return false;
  const target = state
    .getAllPaneTabs()
    .find(
      (tab) =>
        tab.id === state.activeTabId && isOrdinaryTeamTab(tab) && tab.teamName === identity.teamName
    );
  const pane = state.paneLayout.panes.find(
    (candidate) => candidate.id === state.paneLayout.focusedPaneId
  );
  if (!target || pane?.activeTabId !== target.id) return false;
  state.setPendingReviewRequest({
    ...scope,
    taskId: identity.taskId,
    targetTeamTabId: target.id,
    nonce: crypto.randomUUID(),
    status: 'pending',
    ...options,
  });
  return true;
}

export function isTaskDetailReviewTargetCurrent(
  state: AppState,
  request: TaskDetailReviewRequest,
  teamName: string,
  tabId: string | null
): boolean {
  if (
    state.isContextSwitching ||
    request.teamName !== teamName ||
    state.selectedTeamName !== teamName ||
    request.targetTeamTabId !== tabId ||
    state.pendingReviewRequest?.nonce !== request.nonce
  )
    return false;
  if (!isTaskDetailReadScopeCurrent(request, state.activeContextId, teamName)) return false;
  return state.paneLayout.panes.some(
    (pane) =>
      pane.activeTabId === tabId &&
      pane.tabs.some(
        (tab) => tab.id === tabId && isOrdinaryTeamTab(tab) && tab.teamName === teamName
      )
  );
}
