/** Confirmed ownership retained by this exact failed primary restart call. */
export interface TeamMemberRestartRetention {
  teamName: string;
  memberName: string;
  predecessorRunId: string;
  successorRunId: string;
}

export type TeamMemberRestartResult =
  | { status: 'restarted' }
  | ({ status: 'failed_retained'; error: string } & TeamMemberRestartRetention);

/** Validate plain data before it crosses the Electron context bridge. */
export function parseTeamMemberRestartResult(value: unknown): TeamMemberRestartResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid member restart result');
  const result = value as Record<string, unknown>;
  if (result.status === 'restarted') return { status: 'restarted' };
  const keys = ['error', 'teamName', 'memberName', 'predecessorRunId', 'successorRunId'] as const;
  if (
    result.status !== 'failed_retained' ||
    keys.some((key) => typeof result[key] !== 'string' || !result[key].trim()) ||
    result.predecessorRunId === result.successorRunId
  )
    throw new Error('Invalid retained member restart result');
  return {
    status: 'failed_retained',
    error: result.error as string,
    teamName: result.teamName as string,
    memberName: result.memberName as string,
    predecessorRunId: result.predecessorRunId as string,
    successorRunId: result.successorRunId as string,
  };
}
