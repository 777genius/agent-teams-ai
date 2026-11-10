import type { TeamChangeEvent } from '@shared/types';

const RUNTIME_TASK_EVENT_DETAIL_PREFIX = 'opencode-runtime-task-event:';

export function isTaskLogActivityChangeEvent(event: TeamChangeEvent): boolean {
  if (event.type !== 'task-log-change') {
    return false;
  }
  if (event.taskSignalKind === 'log') {
    return true;
  }
  if (event.taskSignalKind === 'change') {
    return false;
  }
  return (
    typeof event.detail === 'string' && event.detail.startsWith(RUNTIME_TASK_EVENT_DETAIL_PREFIX)
  );
}
