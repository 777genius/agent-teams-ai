import type { TeamMemberRestartRetention } from '@shared/types/teamMemberRestart';

/** Internal domain failure; the IPC adapter publishes its confirmed ownership facts. */
export class OpenCodeRetainedPrimaryRestartError extends Error {
  readonly retention: Readonly<TeamMemberRestartRetention>;

  constructor(message: string, retention: TeamMemberRestartRetention) {
    super(message);
    this.name = 'OpenCodeRetainedPrimaryRestartError';
    this.retention = Object.freeze({ ...retention });
  }
}
