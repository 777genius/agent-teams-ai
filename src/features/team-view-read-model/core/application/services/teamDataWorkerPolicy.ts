import type {
  RuntimeEnvironmentPort,
  TeamDataWorkerPolicyPort,
  TeamViewReadLoggerPort,
} from '../ports/TeamViewReadModelPorts';

export function getTeamDataWorkerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwIfFatalTeamDataWorkerFailure(
  worker: TeamDataWorkerPolicyPort,
  error: unknown
): void {
  if (worker.isFatalError(error)) {
    throw new Error(`TEAM_DATA_WORKER_FAILED: ${getTeamDataWorkerErrorMessage(error)}`);
  }
}

export function noteHeavyTeamDataWorkerFallback(
  environment: RuntimeEnvironmentPort,
  logger: TeamViewReadLoggerPort,
  operation: string
): void {
  if (!environment.isPackaged()) {
    return;
  }
  logger.error(
    `[${operation}] team-data-worker unavailable in packaged runtime; falling back to main-thread execution for heavy message/activity path`
  );
}
