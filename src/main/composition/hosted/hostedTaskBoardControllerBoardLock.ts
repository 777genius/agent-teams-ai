import { withFileLock } from '@main/services/team/fileLock';

import {
  descriptorChildPath,
  type HostedTaskBoardDirectoryDescriptor,
} from './hostedTaskBoardDescriptorFs';

// Same resource as agent-teams-controller boardLock.js and TeamTaskActivityIntervalService.
const CONTROLLER_BOARD_LOCK_RESOURCE = 'board-state';

/**
 * Agents mutate the same task and kanban files through the MCP controller, which reads
 * and writes them under `<team>/board-state`. Product holds that lock while it applies a
 * prepared WAL, from the final preimage checks through the postimage checks and terminal
 * WAL, so an agent write based on a preimage cannot land over a Product postimage.
 * Order stays Product authority -> team Product lock -> board lock; no other file lock
 * is acquired while it is held. Authority reads before the WAL is prepared stay outside.
 */
export function withHostedTaskBoardControllerLock<T>(
  teamDirectory: HostedTaskBoardDirectoryDescriptor,
  run: () => Promise<T>
): Promise<T> {
  return withFileLock(descriptorChildPath(teamDirectory, CONTROLLER_BOARD_LOCK_RESOURCE), run);
}
