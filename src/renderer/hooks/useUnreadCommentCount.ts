import { useSyncExternalStore } from 'react';

import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';

import type { TaskComment } from '@shared/types';

export function useUnreadCommentCount(
  teamName: string,
  taskId: string,
  comments: TaskComment[] | undefined
): number {
  const readState = useSyncExternalStore(subscribe, getSnapshot);
  return getUnreadCount(readState, teamName, taskId, comments ?? []);
}
