import assert from 'node:assert/strict';
import { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';
import { runDesktopTaskReviewCycleUiSmoke, runDesktopTaskNotificationUiSmoke } from './desktop-task-review-cycle-ui-smoke.ts';
import { runDesktopCrossTeamUiSmoke } from './desktop-cross-team-ui-smoke.ts';
import { runDesktopOversizedCommentUiSmoke } from './desktop-oversized-comment-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** Existing flows can run together or qualify the remaining cross-Team workflow alone. */
export async function runDesktopOfflineTaskBoardUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1],
  mode: string
) {
  assert.ok(['task-board-ui', 'task-board-cross-team-ui', 'cross-team-ui'].includes(mode));
  if (mode === 'cross-team-ui') {
    await runDesktopCrossTeamUiSmoke(cdp, options);
    return;
  }
  await runDesktopTaskBoardUiSmoke(cdp, options);
  if (mode === 'task-board-ui') {
    await runDesktopTaskNotificationUiSmoke(cdp, options);
    return;
  }
  await runDesktopTaskReviewCycleUiSmoke(cdp, options);
  await runDesktopTaskNotificationUiSmoke(cdp, options);
  await runDesktopCrossTeamUiSmoke(cdp, options);
  // UI composer is intentionally capped; this tests accepted large Host
  // comments through the existing Task detail after a cold renderer reload.
  const steps: Record<string, unknown>[] = [];
  options.evidence.oversizedCommentUiProof = await runDesktopOversizedCommentUiSmoke(cdp, {
    root: options.root,
    handleId: options.handleId,
    taskId: options.seed.taskId,
    subject: options.seed.subject,
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (row) => { steps.push(row); },
  });
  options.evidence.oversizedCommentUiSteps = steps;
}
