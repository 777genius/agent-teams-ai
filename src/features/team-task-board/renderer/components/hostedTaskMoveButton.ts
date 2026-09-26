import { HOSTED_TASK_BOARD_COLUMNS, type HostedTaskStatus } from '../../contracts/hosted';

const COMPLETE_FIRST = 'Complete the task first (Next status)';

/**
 * Move left/right button state. As on desktop, only a completed task enters review or approval;
 * Next status completes it first, so the controller never has to refuse the move.
 */
export function hostedTaskMoveButtonProps(
  targetIndex: number,
  status: HostedTaskStatus,
  disabled: boolean
): { readonly disabled: boolean; readonly title?: string } {
  const column = HOSTED_TASK_BOARD_COLUMNS[targetIndex];
  if (column === undefined) return { disabled: true };
  if ((column === 'review' || column === 'approved') && status !== 'completed') {
    return { disabled: true, title: COMPLETE_FIRST };
  }
  return { disabled };
}
