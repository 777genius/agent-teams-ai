import { isTeamTaskActivelyWorked } from '@shared/utils/teamTaskState';

import type { TeamTaskWithKanban } from '@shared/types';

export function isDisplayableCurrentTask(
  task: TeamTaskWithKanban | null | undefined
): task is TeamTaskWithKanban {
  return Boolean(task && isTeamTaskActivelyWorked(task));
}
