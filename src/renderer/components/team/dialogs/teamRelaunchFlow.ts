import type { TeamCreateRequest, TeamLaunchRequest, TeamRelaunchStopOutcome } from '@shared/types';

interface ExecuteTeamRelaunchOptions {
  teamName: string;
  isTeamAlive: boolean;
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  stopTeam: (teamName: string) => Promise<TeamRelaunchStopOutcome>;
  replaceMembers: (
    teamName: string,
    request: { members: TeamCreateRequest['members'] }
  ) => Promise<void>;
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export type TeamRelaunchPreDispatchFailureKind =
  | 'aborted-before-stop'
  | 'aborted-after-stop'
  | 'stop-rejected';

/**
 * A durable roster transaction can be rolled back only when launch definitely
 * was not dispatched. An authoritative stop result still permits the exact
 * transaction rollback that releases a stale dialog generation's reservation.
 */
export class TeamRelaunchKnownPreDispatchFailure extends Error {
  readonly name = 'TeamRelaunchKnownPreDispatchFailure';

  constructor(
    readonly kind: TeamRelaunchPreDispatchFailureKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** Marks a rejected stop transport whose server-side outcome is not known. */
export class TeamRelaunchStopOutcomeUnknownError extends Error {
  readonly name = 'TeamRelaunchStopOutcomeUnknownError';

  constructor(
    message: string,
    readonly outcome?: Extract<TeamRelaunchStopOutcome, { status: 'outcome-unknown' }>,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export function isTeamRelaunchKnownPreDispatchFailure(
  error: unknown
): error is TeamRelaunchKnownPreDispatchFailure {
  return error instanceof TeamRelaunchKnownPreDispatchFailure;
}

export async function executeTeamRelaunch({
  teamName,
  isTeamAlive,
  request,
  members,
  stopTeam,
  replaceMembers,
  launchTeam,
  signal,
  isCurrent,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  const isAborted = (): boolean => signal?.aborted === true || isCurrent?.() === false;
  const throwIfAborted = (kind: TeamRelaunchPreDispatchFailureKind, message: string): void => {
    if (!isAborted()) return;
    throw new TeamRelaunchKnownPreDispatchFailure(kind, message, { cause: signal?.reason });
  };

  throwIfAborted('aborted-before-stop', 'Team relaunch was aborted before stop dispatch');
  if (isTeamAlive) {
    let outcome: TeamRelaunchStopOutcome;
    try {
      outcome = await stopTeam(teamName);
    } catch (error) {
      throw new TeamRelaunchStopOutcomeUnknownError(
        'The current team stop outcome is unknown; the roster remains reserved.',
        undefined,
        { cause: error }
      );
    }
    if (outcome.status === 'not-dispatched') {
      throw new TeamRelaunchKnownPreDispatchFailure(
        'stop-rejected',
        `The current team stop was authoritatively rejected before dispatch: ${outcome.diagnostic}`
      );
    }
    if (outcome.status === 'outcome-unknown') {
      throw new TeamRelaunchStopOutcomeUnknownError(
        `The current team stop outcome is unknown; the roster remains reserved. ${outcome.diagnostic}`,
        outcome
      );
    }
    // Closing and reopening the dialog transfers generation ownership. Once
    // stop is durable, the stale generation must resolve its roster reservation
    // through the caller's exact rollback path instead of launching.
    throwIfAborted('aborted-after-stop', 'Team relaunch was aborted after stop completed');
  }
  // A roster-bound relaunch already applied the target roster after durably
  // snapshotting the prior roster. Mutating it again would escape the CAS fence.
  if (!request.rosterTransactionId) {
    await replaceMembers(teamName, { members });
  }
  throwIfAborted('aborted-after-stop', 'Team relaunch was aborted before launch dispatch');
  await launchTeam(request);
}
