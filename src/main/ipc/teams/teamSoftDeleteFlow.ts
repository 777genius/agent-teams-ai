const STOP_TIMEOUT_MS = 5_000;

export interface TeamSoftDeleteFlowPorts {
  stopTeam(teamName: string): Promise<void>;
  softDeleteTeam(teamName: string): Promise<void>;
  invalidateTeamConfig(teamName: string): void;
  /** Forget background lane stop backoff; see softDeleteTeamWithBestEffortStop. */
  clearStoppedLaneStopBackoff(teamName: string): void;
  logWarning(message: string): void;
}

/**
 * Move a team to the trash.
 *
 * Stopping the team is attempted first, because leaving lanes running against a
 * trashed team is worse than not, but only that part is best effort: a stop that
 * rejects (an OpenCode lane that keeps runtime ownership because it never
 * confirms the stop) is logged, and a stop that has not settled within
 * STOP_TIMEOUT_MS is no longer awaited here.
 *
 * The soft delete itself is not bounded. It is a configuration change, so it
 * runs under the team lock like every other one, and it waits for whatever is
 * ahead of it there: the stop that was given up on above, and a background
 * cleanup that may still be asking the bridge to stop a stopped team's OpenCode
 * lanes, one lane after another. That can take minutes. The renderer shows the
 * request as busy for that time, a repeated request for the same team joins the
 * running one (createTeamSoftDeleteRequests), and background cleanup backs off
 * from lane runs whose stop it could not confirm, so it does not keep taking the
 * lock again. That backoff is cleared only after the soft delete succeeded:
 * clearing it earlier would let a background pass queue on the lock ahead of
 * the soft delete.
 *
 * Its failure is the caller's to report, and the config cache and the backoff
 * are only touched once the delete succeeded.
 */
export async function softDeleteTeamWithBestEffortStop(
  teamName: string,
  ports: TeamSoftDeleteFlowPorts
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const stopOutcome = ports.stopTeam(teamName).then(
      () => 'stopped' as const,
      (error: unknown) => {
        ports.logWarning(
          `[${teamName}] Failed to stop team runtime before trash; continuing with soft delete: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return 'stop_failed' as const;
      }
    );
    const outcome = await Promise.race([
      stopOutcome,
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (outcome === 'timed_out') {
      ports.logWarning(
        `[${teamName}] Stopping team runtime did not finish within ${STOP_TIMEOUT_MS}ms before trash; continuing with soft delete.`
      );
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  await ports.softDeleteTeam(teamName);
  ports.invalidateTeamConfig(teamName);
  try {
    ports.clearStoppedLaneStopBackoff(teamName);
  } catch (error) {
    // The team is already in the trash; report that, not this.
    ports.logWarning(
      `[${teamName}] Failed to clear background lane stop backoff after trash: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export interface TeamSoftDeleteRequests {
  /**
   * Move the team to the trash, or join the request for it that is already
   * running. A joined caller gets that request's result, success or failure.
   */
  softDelete(teamName: string, ports: TeamSoftDeleteFlowPorts): Promise<void>;
}

/**
 * One trash request per team at a time.
 *
 * Trashing can wait minutes behind the team lock (see
 * softDeleteTeamWithBestEffortStop). A second click, a second window or a retry
 * during that wait must not start another stop and another delete that queue up
 * behind the first one. The entry is dropped when the request settles, so a
 * later request, including a retry after a failure, runs again.
 */
export function createTeamSoftDeleteRequests(): TeamSoftDeleteRequests {
  const inFlight = new Map<string, Promise<void>>();
  return {
    softDelete(teamName, ports) {
      const teamKey = teamName.trim().toLowerCase();
      const running = inFlight.get(teamKey);
      if (running) {
        return running;
      }
      const request = softDeleteTeamWithBestEffortStop(teamName, ports).finally(() => {
        if (inFlight.get(teamKey) === request) {
          inFlight.delete(teamKey);
        }
      });
      inFlight.set(teamKey, request);
      return request;
    },
  };
}
