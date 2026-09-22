import {
  type DurablePathRemovalProofHooks,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';
import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'path';

const PERMANENT_DELETE_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export interface PermanentTeamDataDeletionOptions {
  skipTeamData?: boolean;
  skipTaskData?: boolean;
  teamDataProofHooks?: DurablePathRemovalProofHooks;
  taskDataProofHooks?: DurablePathRemovalProofHooks;
}

export async function permanentlyDeleteTeamData(input: {
  teamName: string;
  isTeamDataCurrent: (detachedPath?: string) => Promise<boolean>;
  isTaskDataCurrent: (detachedPath?: string) => Promise<boolean>;
  options: PermanentTeamDataDeletionOptions;
  onTeamDataDeleted(): void;
  onTaskDataDeleted(): void;
}): Promise<boolean> {
  if (!input.options.skipTeamData) {
    const teamRemoval = await removePathWithIdentityFenceAsync(
      path.join(getTeamsBasePath(), input.teamName),
      {
        ...PERMANENT_DELETE_RM_OPTIONS,
        durability: 'strict',
        reservePublicDirectory: true,
        validateDetached: (detachedPath) => input.isTeamDataCurrent(detachedPath),
        ...(input.options.teamDataProofHooks
          ? { proofHooks: input.options.teamDataProofHooks }
          : {}),
      }
    );
    const teamRemovalCompleted = input.options.teamDataProofHooks
      ? teamRemoval === 'deleted'
      : teamRemoval !== 'changed';
    if (!teamRemovalCompleted) return false;
    input.onTeamDataDeleted();
  }

  if (!input.options.skipTaskData) {
    const taskRemoval = await removePathWithIdentityFenceAsync(
      path.join(getTasksBasePath(), input.teamName),
      {
        ...PERMANENT_DELETE_RM_OPTIONS,
        durability: 'strict',
        reservePublicDirectory: true,
        validateDetached: (detachedPath) => input.isTaskDataCurrent(detachedPath),
        ...(input.options.taskDataProofHooks
          ? { proofHooks: input.options.taskDataProofHooks }
          : {}),
      }
    );
    const taskRemovalCompleted = input.options.taskDataProofHooks
      ? taskRemoval === 'deleted'
      : taskRemoval !== 'changed';
    if (!taskRemovalCompleted) return false;
    input.onTaskDataDeleted();
  }
  return true;
}
