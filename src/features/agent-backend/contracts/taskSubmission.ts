/** Safe correlation for explicit lookup; transport failure never grants replay authority. */
export class HostTeamOperationError extends Error {
  readonly code: string;
  readonly outcome: string;
  readonly commandId?: string;

  constructor(code: string, outcome: string, commandId?: string) {
    super(`Host team operation ${code} (${outcome})`);
    this.code = code;
    this.outcome = outcome;
    this.commandId = commandId;
  }
}

/** Only a pre-dispatch refusal or validated original no-effect receipt may release Task intent. */
export class HostTaskSubmissionRefusal extends HostTeamOperationError {
  constructor(code: string, outcome: 'not-dispatched' | 'rejected', commandId: string) {
    super(code, outcome, commandId);
    this.name = 'HostTaskSubmissionRefusal';
  }
}
