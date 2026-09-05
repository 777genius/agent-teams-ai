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
const publicationQueueByTeam = new Map<string, Promise<unknown>>();

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
export const TEAM_LAUNCH_STOPPED_MARKER_FILE = 'launch-stopped.json';

export function getTeamLaunchStoppedMarkerPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_STOPPED_MARKER_FILE);
}

export interface TeamLaunchStatePublicationOptions {
  /**
   * True when the write republishes launch truth that already existed instead
   * of starting a launch: the rollback of a stale write restoring what it
   * overwrote, or a recovery re-deriving the run that was just stopped. Only a
   * launch may lift a stop, so a stop that landed meanwhile stays final over
   * such a write - it is not published, and it never removes the marker.
   */
  republishesExistingLaunch?: boolean;
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

/** Reports the revocation failures the caller has to see; silent when there are none. */
function throwPublicationRevocationFailure(
  teamName: string,
  results: PromiseSettledResult<void>[]
): void {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state publication`);
  }
}

function enqueuePublication<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
  const previous = publicationQueueByTeam.get(teamName);
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
  publicationQueueByTeam.set(teamName, queued);
  return queued.finally(() => {
    if (publicationQueueByTeam.get(teamName) === queued) {
      publicationQueueByTeam.delete(teamName);
    }
  });
}

/**
 * Runs `operation` in this team's launch-state publication queue - the same one
 * `write` and `markStopped` use. A caller that publishes or withdraws these
 * files from outside the store needs it, because a stop is not one instant:
 * `markStopped` removes the publication files first and writes its marker
 * afterwards, and only the queue makes those two steps indivisible from the
 * outside. Checking the marker without holding the queue reads a stop that has
 * begun as a stop that never happened.
 */
export function withTeamLaunchStatePublicationLock<T>(
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  return enqueuePublication(teamName, operation);
}

/**
 * What a launch-state read found. `absent` is an answer - this team published
 * no launch state - while `unreadable` is the lack of one: something is on
 * disk that the store could not turn into a snapshot, so nothing may be
 * concluded about what the team has running.
 */
export type TeamLaunchStateReadResult =
  | { status: 'snapshot'; snapshot: PersistedTeamLaunchSnapshot }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string };

function describeReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TeamLaunchStateStore {
  /**
   * The launch snapshot, or `null` when there is none to be had. It cannot say
   * why: a team that never launched and a launch state this app could not read
   * both answer `null`. Callers that draw a conclusion from the absence of
   * recorded state - "nothing is running" - need `readResult` instead.
   */
  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const result = await this.readResult(teamName);
    return result.status === 'snapshot' ? result.snapshot : null;
  }

  /**
   * The same read, keeping "this team has no launch state" apart from "the
   * launch state could not be read". Only the first is evidence about the team;
   * the second is the absence of evidence, and a caller that counts it as an
   * empty snapshot reports a probe that answered nothing as a definite zero.
   */
  async readResult(teamName: string): Promise<TeamLaunchStateReadResult> {
    const targetPath = getTeamLaunchStatePath(teamName);
    let raw: string;
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        return { status: 'unreadable', reason: 'launch state path is not a file' };
      }
      if (stat.size > MAX_LAUNCH_STATE_BYTES) {
        return { status: 'unreadable', reason: `launch state exceeds ${MAX_LAUNCH_STATE_BYTES}B` };
      }
      raw = await fs.promises.readFile(targetPath, 'utf8');
    } catch (error) {
      // Only a missing file is an answer; every other failure leaves the
      // question open.
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { status: 'absent' }
        : { status: 'unreadable', reason: describeReadFailure(error) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      return { status: 'unreadable', reason: describeReadFailure(error) };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (
        record.version === 2 &&
        (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
      ) {
        return { status: 'unreadable', reason: 'launch state names a different team' };
      }
    }
    const snapshot = normalizePersistedLaunchSnapshot(teamName, parsed);
    return snapshot
      ? { status: 'snapshot', snapshot }
      : { status: 'unreadable', reason: 'launch state did not describe a launch' };
  }

  async write(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: TeamLaunchStatePublicationOptions
  ): Promise<void> {
    await enqueuePublication(teamName, () => this.writeNow(teamName, snapshot, options));
  }

  private async writeNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: TeamLaunchStatePublicationOptions
  ): Promise<void> {
    const launchStatePath = getTeamLaunchStatePath(teamName);
    const launchSummaryPath = getTeamLaunchSummaryPath(teamName);
    // Only a launch supersedes a stop. An active snapshot that merely
    // republishes what was already on disk is not one, so it is fenced by the
    // marker exactly like a reconcile write is.
    const startsLaunch =
      snapshot.launchPhase === 'active' && options?.republishesExistingLaunch !== true;
    try {
      if (!startsLaunch && (await this.isStopped(teamName))) {
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
      if (startsLaunch) {
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
      const revocations = await Promise.allSettled([
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
      // The marker comes first even when a publication file survives, because
      // a stop the user asked for must stay final for reconciliation. What
      // must not stay silent is the survivor: read() answers from the launch
      // state and not from the marker, so a snapshot that could not be removed
      // is still served to the UI. The caller reports it as a stop diagnostic.
      throwPublicationRevocationFailure(teamName, revocations);
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
      throwPublicationRevocationFailure(
        teamName,
        await Promise.allSettled([
          fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true }),
          fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true }),
        ])
      );
    });
  }
}
