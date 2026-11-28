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
  const capturedRequest = structuredClone(request);
  get().subscribeProvisioningProgress();
  const response = await unwrapIpc('team:create', () => api.teams.createTeam(capturedRequest));
  if (!isContextScopedRequestEpochCurrent(epoch))
    throw new Error('Team context changed after Create.');
  if (!response.teamName) throw new Error('Invalid Host Create result.');
  const logicalHandleId = parseHostTeamSelectionKey(response.teamName);
  const executionHandleId = parseHostTeamRunId(response.runId).handleId;
  if (logicalHandleId !== executionHandleId) {
    const backend = api.agentBackend;
    if (
      !backend ||
      !response.executionTeamName ||
      parseHostTeamSelectionKey(response.executionTeamName) !== executionHandleId ||
      response.projectContext?.logicalHandleId !== logicalHandleId
    )
      throw new Error('Invalid Host project Create result.');
    const [snapshot, view] = await Promise.all([
      backend.getConnections().then((value) => structuredClone(value)),
      api.teams.getProjectContextView(response.teamName, capturedRequest.cwd),
    ]);
    if (!isContextScopedRequestEpochCurrent(epoch))
      throw new Error('Team context changed after Create.');
    const bindings = structuredClone(snapshot.bindings);
    const logical = bindings.filter((row) => row.handle.handleId === logicalHandleId);
    const execution = bindings.filter((row) => row.handle.handleId === executionHandleId);
    const owner = logical[0],
      child = execution[0];
    if (
      snapshot.state !== 'ready' ||
      logical.length !== 1 ||
      execution.length !== 1 ||
      !owner.ownerResourceRef ||
      owner.projectContext ||
      owner.projectContextMode !== 'per_project' ||
      !owner.teamResourceRef ||
      !child.teamResourceRef ||
      child.teamResourceRef === owner.teamResourceRef ||
      snapshot.unavailableOwners?.some(
        (unavailable) => unavailable.ownerResourceRef === owner.ownerResourceRef
      ) ||
      child.ownerResourceRef !== owner.ownerResourceRef ||
      child.projectContext?.logicalHandleId !== logicalHandleId ||
      child.projectContext.projectPath !== response.projectContext.projectPath ||
      child.projectContext.workContextId !== response.projectContext.workContextId ||
      view.mode !== 'per_project' ||
      view.state !== 'ready' ||
      view.executionTeamName !== response.executionTeamName ||
      view.projectPath !== child.projectContext.projectPath ||
      view.workContextId !== child.projectContext.workContextId
    )
      throw new Error('Host project Create association changed.');
  } else if (
    response.projectContext ||
    response.executionTeamName ||
    capturedRequest.projectContextMode === 'per_project'
  ) {
    throw new Error('Invalid Host execution result.');
  }
  // The existing adapter projects Host progress; no optimistic legacy card or settings writes.
  await get()
    .fetchTeams()
    .catch(() => undefined);
  if (!isContextScopedRequestEpochCurrent(epoch))
    throw new Error('Team context changed after Create.');
  if (response.launchStatus === 'unconfirmed') return response;
  await get()
    .getProvisioningStatus(response.runId)
    .catch(() => undefined);
  if (isContextScopedRequestEpochCurrent(epoch)) void poll(get, response.runId);
  return response;
}
