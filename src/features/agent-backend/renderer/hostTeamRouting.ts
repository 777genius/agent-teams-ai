import { isHostTeamRunId } from '../contracts/teamRunSelection';
import { isHostTeamSelectionKey } from '../contracts/teamSelection';

export { hostTeamSelectionKey, isHostTeamSelectionKey } from '../contracts/teamSelection';

function row(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Existing TeamsAPI has both positional and request-shaped Team destinations. */
export function hasHostTeamDestination(method: PropertyKey, argument: unknown): boolean {
  if (isHostTeamSelectionKey(argument) || isHostTeamRunId(argument)) return true;
  const request = row(argument);
  if (isHostTeamSelectionKey(request?.teamName)) return true;
  if (isHostTeamRunId(request?.runId)) return true;
  // A notification can carry its Team solely in its structured click target.
  // Neither destination may escape into legacy notification storage/deep links.
  return (
    method === 'showMessageNotification' && isHostTeamSelectionKey(row(request?.target)?.teamName)
  );
}
