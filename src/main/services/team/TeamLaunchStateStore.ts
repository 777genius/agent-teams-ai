import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { normalizePersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import {
  createPersistedLaunchSummaryProjection,
  TEAM_LAUNCH_SUMMARY_FILE,
} from './TeamLaunchSummaryProjection';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const logger = createLogger('Service:TeamLaunchStateStore');
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';
const MAX_LAUNCH_STATE_BYTES = 256 * 1024;
const publicationQueueByTeam = new Map<string, Promise<void>>();

export function getTeamLaunchStatePath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_STATE_FILE);
}

export function getTeamLaunchSummaryPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_SUMMARY_FILE);
}

/**
 * Marker written when a team is stopped. While it exists, launch-state
 * reconciliation must not re-derive a half-launched snapshot from leftover
 * metadata: a stopped mixed OpenCode team used to come back as "Last launch
 * failed partway - 2/3 teammates did not join", with members reported as
 * never spawned, because the lane metadata of the run that was just stopped
 * was still on disk. Any new active launch-state write (a real launch)
 * removes it.
 */
const TEAM_LAUNCH_STOPPED_MARKER_FILE = 'launch-stopped.json';

export function getTeamLaunchStoppedMarkerPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_STOPPED_MARKER_FILE);
}

async function removeStoppedMarkerIfPresent(teamName: string): Promise<void> {
  const markerPath = getTeamLaunchStoppedMarkerPath(teamName);
  if (!fs.existsSync(markerPath)) return;
  await fs.promises.rm(markerPath, { force: true });
}

async function isMissingTeamDirectoryWriteRace(
  targetPath: string,
  error: unknown
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'EINVAL') {
    return false;
  }
  const targetDir = path.dirname(targetPath);
  try {
    await fs.promises.access(targetDir);
    return false;
  } catch (accessError) {
    return (accessError as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function enqueuePublication(teamName: string, operation: () => Promise<void>): Promise<void> {
  const previous = publicationQueueByTeam.get(teamName);
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
  publicationQueueByTeam.set(teamName, queued);
  return queued.finally(() => {
    if (publicationQueueByTeam.get(teamName) === queued) {
      publicationQueueByTeam.delete(teamName);
    }
  });
}

export class TeamLaunchStateStore {
  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const targetPath = getTeamLaunchStatePath(teamName);
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
        return null;
      }
      const raw = await fs.promises.readFile(targetPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          record.version === 2 &&
          (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
        ) {
          return null;
        }
      }
      return normalizePersistedLaunchSnapshot(teamName, parsed);
    } catch {
      return null;
    }
  }

  async write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    await enqueuePublication(teamName, () => this.writeNow(teamName, snapshot));
  }

  private async writeNow(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    const launchStatePath = getTeamLaunchStatePath(teamName);
    const launchSummaryPath = getTeamLaunchSummaryPath(teamName);
    try {
      if (snapshot.launchPhase !== 'active' && (await this.isStopped(teamName))) {
        // Late reconcile/finish writes from an abandoned stop or a stale run
        // must not resurrect launch state for a stopped team.
        logger.debug(
          `[${teamName}] Ignoring ${snapshot.launchPhase} launch-state write: team is stopped`
        );
        return;
      }
      await atomicWriteAsync(launchStatePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await atomicWriteAsync(
        launchSummaryPath,
        `${JSON.stringify(createPersistedLaunchSummaryProjection(snapshot), null, 2)}\n`
      );
      if (snapshot.launchPhase === 'active') {
        // A real launch supersedes any earlier stop.
        await removeStoppedMarkerIfPresent(teamName);
      }
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(launchStatePath, error)) {
        return;
      }
      logger.warn(
        `[${teamName}] Failed to persist launch-state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /** Stopped team: no launch state, and reconciliation stays off until the next launch. */
  async markStopped(teamName: string): Promise<void> {
    await enqueuePublication(teamName, async () => {
      await Promise.allSettled([
        fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true }),
        fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true }),
      ]);
      const markerPath = getTeamLaunchStoppedMarkerPath(teamName);
      try {
        await atomicWriteAsync(
          markerPath,
          `${JSON.stringify({ version: 1, teamName, stoppedAt: new Date().toISOString() }, null, 2)}\n`
        );
      } catch (error) {
        if (await isMissingTeamDirectoryWriteRace(markerPath, error)) {
          return;
        }
        throw error;
      }
    });
  }

  async isStopped(teamName: string): Promise<boolean> {
    return fs.existsSync(getTeamLaunchStoppedMarkerPath(teamName));
  }

  /**
   * Removes the launch publication only. The stop marker survives a clear:
   * stop flows and stale-write cleanups clear the publication after the team
   * was marked stopped, and only a real launch (an 'active' write) may lift
   * the marker again.
   */
  async clear(teamName: string): Promise<void> {
    await enqueuePublication(teamName, async () => {
      const results = await Promise.allSettled([
        fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true }),
        fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true }),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state publication`);
      }
    });
  }
}
