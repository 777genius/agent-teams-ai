import { createLogger } from '@shared/utils/logger';

import type { TeamLogSourceReleasedConsumers } from '@main/services/team/TeamLogSourceTracker';

const logger = createLogger('TeamScopedResourceReleaser');

/** Give Windows a beat to finish closing the released directory handles. */
const RESOURCE_RELEASE_SETTLE_MS = 150;

export interface TeamScopedResourceReleaserPorts {
  /** Returns labels for the watch sets that actually held live targets. */
  suspendTeamWatchers(teamName: string): Promise<string[]>;
  resumeTeamWatchers(teamName: string): Promise<void>;
  /** Returns the log-source acquisitions that were cleared, or null for none. */
  releaseTeamLogSourceWatcher(teamName: string): Promise<TeamLogSourceReleasedConsumers | null>;
  /** Re-acquire what releaseTeamLogSourceWatcher cleared. */
  restoreTeamLogSourceConsumers(
    teamName: string,
    released: TeamLogSourceReleasedConsumers
  ): Promise<void>;
}

export interface TeamScopedResourceReleaser {
  release(teamName: string): Promise<void>;
  restore(teamName: string, options?: { deletionCompleted?: boolean }): Promise<void>;
}

/**
 * Close the process's own handles inside teams/<team> and tasks/<team> right
 * before permanent deletion renames those directories aside.
 *
 * Windows refuses to rename a directory while any handle inside its tree is
 * open, and a directory watcher's handle stays open until the watcher is
 * closed - it never clears on its own, so the transient rename retry cannot
 * outlast it. The handles this app holds are the two chokidar watch sets and
 * the log-source watcher on teams/<team>/task-log-freshness.
 *
 * Every step is best effort. A failure to release means the rename falls back
 * to the transient retry, which is exactly where it was before, so one broken
 * releaser must not stop the others from running or abort the deletion.
 *
 * Restoring is not symmetric with releasing. The directory watchers are always
 * resumed, because resuming a team whose directory is gone finds nothing to
 * watch. The log-source consumers are only put back when the deletion did not
 * complete: they are owned by the stall monitor and the task-log stream, which
 * would otherwise keep a team they believe they own without receiving its
 * events - and re-acquiring them for a team that was actually deleted would
 * warm a watcher on a directory that no longer exists.
 */
export function createTeamScopedResourceReleaser(
  ports: TeamScopedResourceReleaserPorts
): TeamScopedResourceReleaser {
  const pendingLogSourceRestore = new Map<string, TeamLogSourceReleasedConsumers>();

  return {
    release: async (teamName: string) => {
      const released: string[] = [];
      try {
        released.push(...(await ports.suspendTeamWatchers(teamName)));
      } catch (error) {
        logger.warn(
          `[PermanentDeletion] Failed to suspend team/task watchers for "${teamName}": ${String(error)}`
        );
      }
      try {
        const logSourceConsumers = await ports.releaseTeamLogSourceWatcher(teamName);
        if (logSourceConsumers) {
          pendingLogSourceRestore.set(teamName, logSourceConsumers);
          if (logSourceConsumers.releasedWatcher) {
            released.push('log-source-watch');
          }
        }
      } catch (error) {
        logger.warn(
          `[PermanentDeletion] Failed to release log-source watcher for "${teamName}": ${String(error)}`
        );
      }
      logger.info(
        `[PermanentDeletion] Released team-scoped handles for "${teamName}": ${
          released.length > 0 ? released.join(', ') : 'none held'
        }`
      );
      // Only pay the settle delay when something was actually closed. Deleting
      // a team nothing was watching should not stall on a wait for handles that
      // were never open.
      if (released.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, RESOURCE_RELEASE_SETTLE_MS));
      }
    },
    restore: async (teamName: string, options: { deletionCompleted?: boolean } = {}) => {
      const logSourceConsumers = pendingLogSourceRestore.get(teamName);
      pendingLogSourceRestore.delete(teamName);
      try {
        await ports.resumeTeamWatchers(teamName);
      } catch (error) {
        logger.warn(
          `[PermanentDeletion] Failed to resume team/task watchers for "${teamName}": ${String(error)}`
        );
      }
      if (!logSourceConsumers || options.deletionCompleted === true) {
        return;
      }
      try {
        await ports.restoreTeamLogSourceConsumers(teamName, logSourceConsumers);
      } catch (error) {
        logger.warn(
          `[PermanentDeletion] Failed to restore log-source consumers for "${teamName}": ${String(error)}`
        );
      }
    },
  };
}
