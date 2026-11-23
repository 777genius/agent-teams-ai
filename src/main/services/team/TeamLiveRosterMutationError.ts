/** A live change that must be saved while the team is stopped. */
export class TeamLiveRosterMutationError extends Error {
  readonly code = 'RESTART_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'TeamLiveRosterMutationError';
  }
}
