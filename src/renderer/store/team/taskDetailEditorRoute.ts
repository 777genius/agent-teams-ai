import { normalizeTaskDetailIdentity } from '@features/team-task-detail/core';
import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
} from './taskDetailReadAuthority';

import type { AppState } from '../types';
import type { TaskDetailReadScope } from '@features/team-task-detail/core';

export interface TaskDetailEditorRequest extends TaskDetailReadScope {
  nonce: string;
  targetTeamTabId: string;
  projectPath: string;
  filePath: string;
  line: number | null;
  status: 'pending' | 'opening' | 'blocked';
}

export type TaskDetailEditorIntent = Omit<
  TaskDetailEditorRequest,
  keyof TaskDetailReadScope | 'nonce' | 'targetTeamTabId' | 'status'
>;

export function queueTaskDetailEditor(
  get: () => AppState,
  identityInput: { contextId: string; teamName: string },
  intent: TaskDetailEditorIntent
): boolean {
  const identity = normalizeTaskDetailIdentity({ ...identityInput, taskId: 'editor' });
  const before = get();
  if (
    !identity.contextId ||
    !identity.teamName ||
    !intent.projectPath.trim() ||
    !intent.filePath.trim() ||
    (intent.line !== null && (!Number.isSafeInteger(intent.line) || intent.line < 1)) ||
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
  state.setPendingTaskDetailEditorRequest({
    ...scope,
    ...intent,
    targetTeamTabId: target.id,
    nonce: crypto.randomUUID(),
    status: 'pending',
  });
  return true;
}

export function isTaskDetailEditorTargetCurrent(
  state: AppState,
  request: TaskDetailEditorRequest,
  teamName: string,
  tabId: string | null
): boolean {
  return (
    request.status !== 'blocked' &&
    !state.isContextSwitching &&
    request.teamName === teamName &&
    request.targetTeamTabId === tabId &&
    state.pendingTaskDetailEditorRequest?.nonce === request.nonce &&
    isTaskDetailReadScopeCurrent(request, state.activeContextId, teamName) &&
    state.paneLayout.panes.some(
      (pane) =>
        pane.activeTabId === tabId &&
        pane.tabs.some(
          (tab) => tab.id === tabId && isOrdinaryTeamTab(tab) && tab.teamName === teamName
        )
    )
  );
}
