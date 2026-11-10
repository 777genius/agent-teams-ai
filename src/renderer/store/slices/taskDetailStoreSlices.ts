import { createTaskDetailResourcesSlice } from './taskDetailResourcesSlice';
import { createTeamTaskDetailSlice } from './teamTaskDetailSlice';

import type { TaskDetailResourcesSlice } from './taskDetailResourcesSlice';
import type { TeamTaskDetailSlice } from './teamTaskDetailSlice';

export function createTeamTaskDetailStoreSlices(
  ...args: Parameters<typeof createTeamTaskDetailSlice>
): TeamTaskDetailSlice & TaskDetailResourcesSlice {
  return {
    ...createTeamTaskDetailSlice(...args),
    ...createTaskDetailResourcesSlice(...args),
  };
}
