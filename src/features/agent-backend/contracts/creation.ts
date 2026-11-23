/** Only an original owner-confirmed refusal may release a Create form's retained intent. */
export type TeamCreationRefusalCode = 'invalid' | 'conflict' | 'forbidden' | 'unavailable';
export interface TeamCreationFailure {
  kind: 'captured-team-create-refusal';
  code: TeamCreationRefusalCode;
  outcome: 'not-dispatched' | 'rejected';
}

export class TeamCreationRefusal extends Error {
  readonly code: TeamCreationRefusalCode;
  readonly outcome: TeamCreationFailure['outcome'];

  constructor(code: TeamCreationRefusalCode, outcome: TeamCreationFailure['outcome']) {
    super(`Captured Host creation refused (${code}). Correct the form and try again.`);
    this.name = 'TeamCreationRefusal';
    this.code = code;
    this.outcome = outcome;
  }
}

export const HOST_TEAM_HISTORY_MODE_MESSAGE =
  'Host teams currently support shared history only. Under Team history in Optional launch settings or Optional settings, choose Shared across projects.';

/** Only this finite, pre-dispatch correction is safe to expose through existing Create errors. */
export function isHostTeamHistoryModeRefusal(error: unknown): error is TeamCreationRefusal {
  return (
    error instanceof TeamCreationRefusal &&
    error.code === 'invalid' &&
    error.outcome === 'not-dispatched' &&
    error.message === HOST_TEAM_HISTORY_MODE_MESSAGE
  );
}

export function parseTeamCreationFailure(value: unknown): TeamCreationFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['kind', 'code', 'outcome'].includes(key)) ||
    row.kind !== 'captured-team-create-refusal' ||
    !['invalid', 'conflict', 'forbidden', 'unavailable'].includes(String(row.code)) ||
    !['not-dispatched', 'rejected'].includes(String(row.outcome))
  )
    return undefined;
  return {
    kind: 'captured-team-create-refusal',
    code: row.code as TeamCreationRefusalCode,
    outcome: row.outcome as TeamCreationFailure['outcome'],
  };
}
