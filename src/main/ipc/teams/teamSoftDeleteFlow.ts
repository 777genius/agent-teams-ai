const STOP_TIMEOUT_MS = 5_000;

export interface TeamSoftDeleteFlowPorts {
  stopTeam(teamName: string): Promise<void>;
  softDeleteTeam(teamName: string): Promise<void>;
  invalidateTeamConfig(teamName: string): void;
  logWarning(message: string): void;
}

/**
 * Move a team to the trash.
 *
 * Soft delete is reversible and touches only team data, so it must not depend
 * on the runtime agreeing to shut down first. Stopping the team is still
 * attempted, because leaving lanes running against a trashed team is worse than
 * not - but it is best effort in both directions: a stop that rejects (an
 * OpenCode lane that keeps runtime ownership because it never confirms the
 * stop) and a stop that never settles at all are both logged, and the soft
 * delete proceeds. Before this, either one left the team in the list with no
 * way to remove it.
 *
 * The soft delete itself is not best effort. Its failure is the caller's to
 * report, and the config cache is only invalidated once the delete succeeded.
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
}
