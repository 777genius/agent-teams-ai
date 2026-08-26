import type { TeamCreateRequest, TeamLaunchRequest, TeamLaunchResponse } from '@shared/types';

type RosterBoundRequest = Pick<TeamCreateRequest | TeamLaunchRequest, 'rosterLaunchBinding'>;

export class RosterLaunchKnownNoStartError extends Error {
  readonly cleanupDiagnostics: readonly string[];

  constructor(message: string, cleanupDiagnostics: readonly string[] = []) {
    super(message);
    this.name = 'RosterLaunchKnownNoStartError';
    this.cleanupDiagnostics = [...cleanupDiagnostics];
  }
}

export function asRosterLaunchKnownNoStartError(
  error: unknown,
  context: string,
  cleanupDiagnostics: readonly string[] = []
): Error {
  if (error instanceof RosterLaunchKnownNoStartError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const suffix = cleanupDiagnostics.length > 0 ? `; cleanup: ${cleanupDiagnostics.join('; ')}` : '';
  return new RosterLaunchKnownNoStartError(`${context}: ${detail}${suffix}`, cleanupDiagnostics);
}

/** Report process state; the private IPC authority binds and verifies durable evidence. */
export function withProductionStartedLaunchStatus<T extends TeamLaunchResponse>(
  request: RosterBoundRequest,
  response: T
): T {
  return request.rosterLaunchBinding ? { ...response, launchStatus: 'started' } : response;
}

/** Proof that production completed its attempt with no retained process/member. */
export function withKnownNoStartLaunchStatus<T extends TeamLaunchResponse>(
  request: RosterBoundRequest,
  response: T
): T {
  return request.rosterLaunchBinding ? { ...response, launchStatus: 'not_started' } : response;
}
