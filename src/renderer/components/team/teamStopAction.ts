export type TeamStopActionOutcome =
  | 'stopped'
  | 'stopped_after_transport_error'
  | 'still_running'
  | 'status_unknown';

export type TeamStopFailureKind = Extract<
  TeamStopActionOutcome,
  'still_running' | 'status_unknown'
>;

export interface TeamStopActionPorts {
  teamName: string;
  stop(teamName: string): Promise<void>;
  processAlive(teamName: string): Promise<boolean>;
  refresh(): Promise<void>;
  setBusy(busy: boolean): void;
  reportFailure(kind: TeamStopFailureKind, message: string): void;
  logError(error: unknown): void;
  logRefreshError(error: unknown): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

/** Runs one stop request, probes an uncertain transport result, and refreshes once. */
export async function runTeamStopAction(
  ports: TeamStopActionPorts
): Promise<TeamStopActionOutcome> {
  ports.setBusy(true);
  let outcome: TeamStopActionOutcome;

  try {
    try {
      await ports.stop(ports.teamName);
      outcome = 'stopped';
    } catch (stopError) {
      ports.logError(stopError);
      try {
        const alive = await ports.processAlive(ports.teamName);
        if (alive) {
          outcome = 'still_running';
          ports.reportFailure(outcome, errorMessage(stopError));
        } else {
          outcome = 'stopped_after_transport_error';
        }
      } catch (probeError) {
        ports.logError(probeError);
        outcome = 'status_unknown';
        ports.reportFailure(outcome, errorMessage(probeError));
      }
    }

    try {
      await ports.refresh();
    } catch (refreshError) {
      ports.logRefreshError(refreshError);
    }

    return outcome;
  } finally {
    ports.setBusy(false);
  }
}
