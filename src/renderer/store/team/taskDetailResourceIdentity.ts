import { taskDetailKey } from '@features/team-task-detail/core';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';

export type TaskDetailResourceKind =
  | 'detail'
  | 'changes'
  | 'log-summary'
  | 'log-stream'
  | 'activity'
  | 'activity-detail'
  | 'exact-summaries'
  | 'exact-detail';

export type TaskDetailVisibleResourceKind = Exclude<
  TaskDetailResourceKind,
  'activity-detail' | 'exact-detail'
>;

export function taskDetailResourceKey(
  identity: TaskDetailIdentity,
  kind: TaskDetailResourceKind,
  signature = 'default'
): string {
  return JSON.stringify([taskDetailKey(identity), kind, signature]);
}
