import assert from 'node:assert/strict';
import { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';
import { runDesktopTaskReviewCycleUiSmoke, runDesktopTaskNotificationUiSmoke } from './desktop-task-review-cycle-ui-smoke.ts';
import { runDesktopCrossTeamUiSmoke } from './desktop-cross-team-ui-smoke.ts';
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
}
