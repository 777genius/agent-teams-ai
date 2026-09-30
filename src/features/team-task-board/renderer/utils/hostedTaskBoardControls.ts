import {
  HOSTED_TASK_STATUSES,
  type HostedTaskBoardColumn,
  type HostedTaskBoardItem,
} from '../../contracts/hosted';

export function nextOrder(
  items: readonly HostedTaskBoardItem[],
  column: HostedTaskBoardColumn
): number {
  const highestOrder = items
    .filter((item) => item.column === column)
    .reduce((highest, item) => Math.max(highest, item.order), -1);
  return Math.min(1_000_000, highestOrder + 1);
}

export function nextStatus(status: HostedTaskBoardItem['status']): HostedTaskBoardItem['status'] {
  const index = HOSTED_TASK_STATUSES.indexOf(status);
  return HOSTED_TASK_STATUSES[(index + 1) % HOSTED_TASK_STATUSES.length] ?? 'pending';
}
