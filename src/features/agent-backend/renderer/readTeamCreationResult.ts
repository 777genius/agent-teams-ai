import { parseTeamCreationFailure, TeamCreationRefusal } from '../contracts/creation';

import type { TeamsAPI } from '@shared/types/api';
import type { IpcResult } from '@shared/types/ipc';
import type { TeamCreateConfigResponse, TeamCreateResponse } from '@shared/types/team';

function readCreationResponse<T>(result: IpcResult<T>): T | undefined {
  if (!result || typeof result !== 'object' || typeof result.success !== 'boolean')
    throw new Error('Invalid Create response.');
  if (!result.success) {
    const failure = parseTeamCreationFailure(result.failure);
    if (failure) {
      const error = new TeamCreationRefusal(failure.code, failure.outcome);
      if (result.error) error.message = result.error;
      throw error;
    }
    throw new Error(result.error ?? 'Captured Host creation outcome is unavailable.');
  }
  return result.data;
}

/** Decode the original response in renderer; thrown bridge Error fields are not transport. */
export function readTeamCreationResult(result: IpcResult<TeamCreateResponse>): TeamCreateResponse {
  const data = readCreationResponse(result);
  if (!data) throw new Error('Invalid Host Create response.');
  return data;
}

/** Legacy save-only Create acknowledges success without returning a DTO. */
export function readTeamCreationConfigResult(
  result: IpcResult<void | TeamCreateConfigResponse>
): void | TeamCreateConfigResponse {
  return readCreationResponse(result);
}

/** Both original Create operations share the same narrow result transport decoration. */
export function createTeamCreationResultApi(
  legacy: TeamsAPI
): Pick<TeamsAPI, 'createTeam' | 'createConfig'> {
  return {
    createTeam: async (request) =>
      legacy.createTeamResult
        ? readTeamCreationResult(await legacy.createTeamResult.call(legacy, request))
        : legacy.createTeam.call(legacy, request),
    createConfig: async (request) =>
      legacy.createConfigResult
        ? readTeamCreationConfigResult(await legacy.createConfigResult.call(legacy, request))
        : legacy.createConfig.call(legacy, request),
  };
}
