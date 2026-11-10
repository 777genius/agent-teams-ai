import { parseHostTeamRunId, parseHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '../utils/contextScopedRequestEpoch';

import type { TeamSlice } from '../slices/teamSlice';
import type { TeamCreateRequest, TeamCreateResponse } from '@shared/types/team';

/** Host creates have no legacy name until admission returns the canonical owner selection. */
export async function createHostTeamFromDialog(
  request: TeamCreateRequest,
  get: () => TeamSlice,
  poll: (get: () => TeamSlice, runId: string) => Promise<void>
): Promise<TeamCreateResponse> {
  const epoch = captureContextScopedRequestEpoch();
  get().subscribeProvisioningProgress();
  const response = await unwrapIpc('team:create', () => api.teams.createTeam(request));
  if (!isContextScopedRequestEpochCurrent(epoch))
    throw new Error('Team context changed after Create.');
  if (
    !response.teamName ||
    parseHostTeamSelectionKey(response.teamName) !== parseHostTeamRunId(response.runId).handleId
  )
    throw new Error('Invalid Host Create result.');
  // The existing adapter projects Host progress; no optimistic legacy card or settings writes.
  await get()
    .fetchTeams()
    .catch(() => undefined);
  if (!isContextScopedRequestEpochCurrent(epoch))
    throw new Error('Team context changed after Create.');
  await get()
    .getProvisioningStatus(response.runId)
    .catch(() => undefined);
  if (isContextScopedRequestEpochCurrent(epoch)) void poll(get, response.runId);
  return response;
}
