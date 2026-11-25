import { captureHostProjectLaunchSettings } from '../contracts/projectContext';
import { hostTeamSelectionKey } from '../contracts/teamSelection';

import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendProjectContextSnapshot } from '../contracts/projectContext';
import type { TeamLaunchRequest } from '@shared/types/team';

type Connection = BackendConnectionSnapshot['bindings'][number];
interface Options {
  backend: AgentBackendApi;
  resolve(key: string, current: () => boolean): Promise<Connection>;
}
function check(current: () => boolean, commandId?: string, after = false): void {
  if (!current()) throw new HostTeamOperationError('context-changed', after ? 'unknown' : 'not-dispatched', commandId);
}
export async function readHostProjectContext(backend: AgentBackendApi, connection: Connection,
  current: () => boolean, projectPath?: string | null): Promise<BackendProjectContextSnapshot> {
  check(current);
  const result = await backend.invoke({ handle: { ...connection.handle }, commandId: crypto.randomUUID(),
    operation: 'team.project-context.read', payload: { ...(projectPath?.trim() ? { projectPath } : {}) } });
  check(current);
  if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
  if (!result.value || !('kind' in result.value) || result.value.kind !== 'team-project-context')
    throw new HostTeamOperationError('invalid-result', 'unknown');
  return result.value;
}

/** Selected project and definition fingerprint are original intent; no retry reads newer launch defaults. */
export async function prepareHostProjectLaunch(options: Options, supplied: TeamLaunchRequest,
  current: () => boolean): Promise<TeamLaunchRequest> {
  const request = structuredClone(supplied);
  const original = structuredClone(await options.resolve(request.teamName, current));
  check(current);
  if (original.projectContext) throw new HostTeamOperationError('readonly-project-history', 'not-dispatched');
  const observed = await readHostProjectContext(options.backend, original, current, request.cwd);
  if (observed.view.mode === 'shared') {
    if (original.projectContextMode === 'per_project') throw new HostTeamOperationError('project-context-changed', 'not-dispatched');
    return request;
  }
  const expectedRevision = request.savedSettingsFingerprint;
  if (!request.command || !request.cwd || !expectedRevision || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
      observed.view.state === 'redirect') throw new HostTeamOperationError('launch-source-required', 'not-dispatched');
  const commandId = `${request.command.commandId}:project`;
  check(current, commandId);
  const result = await options.backend.invoke({ handle: { ...original.handle }, commandId,
    operation: 'team.project-context.prepare', payload: { projectPath: request.cwd, expectedRevision,
      ...(request.savedRosterCommandId ? { rosterCommandId: request.savedRosterCommandId } : {}),
      launchSettings: captureHostProjectLaunchSettings(request) } });
  check(current, commandId, true);
  if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome, commandId);
  if (!result.value || !('kind' in result.value) || result.value.kind !== 'team-project-context' ||
      !result.value.prepared || result.value.view.mode !== 'per_project' || result.value.view.state !== 'ready')
    throw new HostTeamOperationError('invalid-result', 'unknown', commandId);
  const { view, prepared } = result.value;
  if (hostTeamSelectionKey(prepared.executionHandle.handleId) !== view.executionTeamName ||
      !/^[a-f0-9]{64}$/.test(prepared.sourceRevision)) throw new HostTeamOperationError('invalid-result', 'unknown', commandId);
  const fresh = await options.backend.getConnections();
  check(current, commandId, true);
  const root = fresh.bindings.find(row => row.handle.handleId === original.handle.handleId);
  const child = fresh.bindings.find(row => row.handle.handleId === prepared.executionHandle.handleId);
  if (fresh.state !== 'ready' || !original.ownerResourceRef || root?.ownerResourceRef !== original.ownerResourceRef ||
      root.teamResourceRef !== original.teamResourceRef || child?.ownerResourceRef !== original.ownerResourceRef ||
      child.projectContext?.logicalHandleId !== original.handle.handleId ||
      child.projectContext.projectPath !== view.projectPath || child.projectContext.workContextId !== view.workContextId)
    throw new HostTeamOperationError('project-context-changed', 'unknown', commandId);
  return { ...request, teamName: view.executionTeamName, cwd: view.projectPath,
    savedRosterCommandId: prepared.rosterCommandId,
    ...(request.modelPreparation ? { modelPreparation: { ...request.modelPreparation,
      projectContext: { logicalHandleId: original.handle.handleId, commandId } } } : {}) };
}
