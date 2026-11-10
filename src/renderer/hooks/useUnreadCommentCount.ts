import { useSyncExternalStore } from 'react';

import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';
import type { TaskComment } from '@shared/types';

export function useUnreadCommentCount(
  identity: TaskDetailIdentity,
  comments: TaskComment[] | undefined
): number {
  const readState = useSyncExternalStore(subscribe, getSnapshot);
  return getUnreadCount(readState, identity, comments ?? []);
}
