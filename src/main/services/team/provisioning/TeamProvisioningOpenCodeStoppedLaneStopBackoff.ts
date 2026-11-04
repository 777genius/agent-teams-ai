/**
 * How long background passes leave a stopped team's OpenCode lane run alone
 * after its stop was not confirmed.
 *
 * Each retry goes through the bridge under the team lock and can hold that lock
 * for minutes (stop budget plus handshake). Delivery, recovery and the watchdog
 * all start this cleanup, so without a pause the lock is taken again right after
 * it is released, and anything the user asks for on that team (trash, edit,
 * launch) queues behind it.
 */
export const OPENCODE_STOPPED_LANE_STOP_BACKOFF_MS = 10 * 60_000;

export interface OpenCodeStoppedLaneStopRef {
  teamName: string;
  laneId: string;
  runId: string;
}

/**
 * In-memory record of lane runs whose stop was just left unconfirmed by a
 * background pass. Only background cleanup consults it; explicit Stop, relaunch
 * and Move to trash use their own stop paths and never wait on it.
 */
export interface OpenCodeStoppedLaneStopBackoff {
  readonly backoffMs: number;
  /** Whether the team has any lane run that is still backed off. */
  hasBackedOffRuns(teamName: string): boolean;
  isBackedOff(ref: OpenCodeStoppedLaneStopRef): boolean;
  recordUnconfirmedStop(input: {
    teamName: string;
    laneId: string;
    runIds: readonly string[];
  }): void;
  /** Called when a stop of the lane was confirmed. */
  clearLane(teamName: string, laneId: string): void;
  /** Called once the team was moved to the trash. */
  clearTeam(teamName: string): void;
}

export function createOpenCodeStoppedLaneStopBackoff(deps: {
  nowMs(): number;
  backoffMs?: number;
}): OpenCodeStoppedLaneStopBackoff {
  const backoffMs = deps.backoffMs ?? OPENCODE_STOPPED_LANE_STOP_BACKOFF_MS;
  // team key -> lane id -> run id -> time until which the run is backed off
  const retryAfterByTeam = new Map<string, Map<string, Map<string, number>>>();

  const pruneExpired = (nowMs: number): void => {
    for (const [teamKey, lanes] of retryAfterByTeam) {
      for (const [laneId, runs] of lanes) {
        for (const [runId, retryAfterMs] of runs) {
          if (retryAfterMs <= nowMs) runs.delete(runId);
        }
        if (runs.size === 0) lanes.delete(laneId);
      }
      if (lanes.size === 0) retryAfterByTeam.delete(teamKey);
    }
  };

  return {
    backoffMs,

    hasBackedOffRuns(teamName) {
      pruneExpired(deps.nowMs());
      return retryAfterByTeam.has(toTeamKey(teamName));
    },

    isBackedOff({ teamName, laneId, runId }) {
      const retryAfterMs = retryAfterByTeam.get(toTeamKey(teamName))?.get(laneId)?.get(runId);
      return retryAfterMs !== undefined && retryAfterMs > deps.nowMs();
    },

    recordUnconfirmedStop({ teamName, laneId, runIds }) {
      const nowMs = deps.nowMs();
      pruneExpired(nowMs);
      if (runIds.length === 0) return;
      const teamKey = toTeamKey(teamName);
      const lanes = retryAfterByTeam.get(teamKey) ?? new Map<string, Map<string, number>>();
      const runs = lanes.get(laneId) ?? new Map<string, number>();
      for (const runId of runIds) {
        runs.set(runId, nowMs + backoffMs);
      }
      lanes.set(laneId, runs);
      retryAfterByTeam.set(teamKey, lanes);
    },

    clearLane(teamName, laneId) {
      const teamKey = toTeamKey(teamName);
      const lanes = retryAfterByTeam.get(teamKey);
      if (!lanes) return;
      lanes.delete(laneId);
      if (lanes.size === 0) retryAfterByTeam.delete(teamKey);
    },

    clearTeam(teamName) {
      retryAfterByTeam.delete(toTeamKey(teamName));
    },
  };
}

function toTeamKey(teamName: string): string {
  return teamName.trim().toLowerCase();
}
