import { parseTeamCreationFailure, TeamCreationRefusal } from '../contracts/creation';

import type { IpcResult } from '@shared/types/ipc';
import type { TeamCreateResponse } from '@shared/types/team';

/** Decode the original Create response in renderer; thrown bridge Error fields are not transport. */
export function readTeamCreationResult(result: IpcResult<TeamCreateResponse>): TeamCreateResponse {
  if (!result || typeof result !== 'object') throw new Error('Invalid Host Create response.');
  if (!result.success) {
    const failure = parseTeamCreationFailure(result.failure);
    if (failure) throw new TeamCreationRefusal(failure.code, failure.outcome);
    throw new Error(result.error ?? 'Captured Host creation outcome is unavailable.');
  }
  if (!result.data) throw new Error('Invalid Host Create response.');
  return result.data;
}
