import { getUnreadCount } from '@renderer/services/commentReadStorage';

import type { TeamTaskWithKanban } from '@shared/types';

/** Contextless graph projections must not consume local-context read markers. */
export function getGraphTaskUnreadCount(
  state: Record<string, unknown> | undefined,
  contextId: string | undefined,
  teamName: string,
  task: TeamTaskWithKanban
): number | undefined {
  if (!state || !contextId) return undefined;
  const count = getUnreadCount(
    state as Parameters<typeof getUnreadCount>[0],
    { contextId, teamName, taskId: task.id },
    task.comments ?? []
  );
  return count > 0 ? count : undefined;
}
