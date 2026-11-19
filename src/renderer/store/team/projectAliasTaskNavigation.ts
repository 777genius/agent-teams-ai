import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import type { AppState } from '../types';

/**
 * A native project alias owns task/read identity, but its visible tab belongs
 * to the logical team. Retarget only the exact pending review/editor nonce.
 */
export function redirectProjectAliasTaskNavigation(
  getState: () => AppState,
  physicalTeamName: string,
  logicalTeamName: string,
  projectPath: string
): void {
  const before = getState();
  const initialContextId = before.activeContextId;
  const sourceTab = before.getAllPaneTabs().find(
    (tab) => tab.id === before.activeTabId &&
      isOrdinaryTeamTab(tab) && tab.teamName === physicalTeamName
  );
  // This mounted alias may belong to an unfocused pane. Never change the
  // user's focused project or tab unless its physical source is still active.
  if (!sourceTab || before.isContextSwitching) return;
  const review = before.pendingReviewRequest;
  const editor = before.pendingTaskDetailEditorRequest;
  before.openTeamTab(logicalTeamName, projectPath);

  const after = getState();
  const destinationTab = after.getAllPaneTabs().find(
    (tab) => tab.id === after.activeTabId &&
      isOrdinaryTeamTab(tab) && tab.teamName === logicalTeamName
  );
  if (!destinationTab || after.isContextSwitching ||
      after.activeContextId !== initialContextId) return;

  if (review && review.teamName === physicalTeamName &&
      review.targetTeamTabId === sourceTab.id &&
      review.status === 'pending' &&
      after.pendingReviewRequest?.nonce === review.nonce) {
    after.setPendingReviewRequest({
      ...review, navigationTeamName: logicalTeamName,
      targetTeamTabId: destinationTab.id,
    });
  }
  if (editor && editor.teamName === physicalTeamName &&
      editor.targetTeamTabId === sourceTab.id &&
      editor.status === 'pending' &&
      after.pendingTaskDetailEditorRequest?.nonce === editor.nonce) {
    after.setPendingTaskDetailEditorRequest({
      ...editor, navigationTeamName: logicalTeamName,
      targetTeamTabId: destinationTab.id,
    });
  }
}
