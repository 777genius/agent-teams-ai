import type { TeamMemberRestartRetention } from '@shared/types/teamMemberRestart';

/** Internal domain failure; the IPC adapter publishes its confirmed ownership facts. */
export class OpenCodeRetainedPrimaryRestartError extends Error {
  readonly outcome: 'failed_retained' | 'failed_restored';
  readonly retention: Readonly<TeamMemberRestartRetention>;

  constructor(
    message: string,
    retention: TeamMemberRestartRetention,
    outcome: 'failed_retained' | 'failed_restored' = 'failed_retained'
  ) {
    super(message);
    this.name = 'OpenCodeRetainedPrimaryRestartError';
    this.outcome = outcome;
    this.retention = Object.freeze({ ...retention });
  }
}
