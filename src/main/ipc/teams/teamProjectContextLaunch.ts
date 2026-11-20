import {
  classifyTeamKind,
  TeamProjectContextLaunchConflictError,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { parseOptionalTeamEffort, parseOptionalTeamFastMode } from '../teamIpcRequestParsers';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';
import { rememberProjectRunIdentity } from './teamProjectContextProgressIdentity';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { IpcResult, TeamLaunchRequest, TeamLaunchResponse, TeamProvisioningProgress } from '@shared/types';

export type ProjectContextProgressMapper = (
  progress: TeamProvisioningProgress,
  deliver: (progress: TeamProvisioningProgress) => void
) => void;

export interface PreparedTeamContextLaunch {
  request: TeamLaunchRequest;
  mapProgress?: ProjectContextProgressMapper;
}

/**
 * Caller holds the logical-team configuration lock and has already checked
 * project path and basic launch request validity. Resolve an existing project
 * (or prepare its draft) before delegating to the unchanged native launch path.
 */
export async function prepareTeamContextLaunch(
  request: TeamLaunchRequest,
  ports: ProjectTeamRuntimePorts,
  options: { expectedExecutionTeamName?: string } = {}
): Promise<PreparedTeamContextLaunch> {
  const parts = createProjectContextRuntimeParts(ports);
  const kind = await classifyTeamKind(
    {
      getMode: (name) => parts.resolver.getMode(name),
      isOwnedExecutionAlias: (name) => parts.registry.isOwnedExecutionAlias(name),
    },
    request.teamName
  );
  // Public launch requests must never bypass logical-team admission by
  // addressing the physical runtime alias directly (e.g. global tasks).
  if (kind === 'alias') {
    throw new Error('Project runtime alias cannot launch directly; open its logical team');
  }
  if (kind === 'native') return { request };
  const logicalMeta = await new TeamMetaStore().getMeta(request.teamName);
  if (logicalMeta?.deletedAt) {
    throw new Error('TEAM_TRASHED: Restore the team before launching');
  }

  const address = { logicalTeamName: request.teamName, projectPath: request.cwd };
  const reserved = await parts.resolver.reserveForProvisioning(address);
  if (!reserved.workContextId || !reserved.projectPath) throw new Error('Missing project context identity');
  const canonicalAddress = {
    logicalTeamName: address.logicalTeamName,
    projectPath: reserved.projectPath,
  };

  try {
    // A caller that must reuse one existing project copy (a schedule) aborts before anything is
    // materialized when the reservation points anywhere else; the catch below releases it.
    if (
      options.expectedExecutionTeamName !== undefined &&
      reserved.executionTeamName !== options.expectedExecutionTeamName
    ) {
      throw new TeamProjectContextLaunchConflictError(
        'The project copy of this team changed while the schedule was starting. Nothing was started'
      );
    }
    await parts.gate.assertOtherContextsStopped(
      address.logicalTeamName, reserved.executionTeamName
    );
    const physical = await parts.materializer.ensureProjectDraft(canonicalAddress);
    if (physical.executionTeamName !== reserved.executionTeamName) {
      throw new Error('Project context changed during launch admission');
    }
    return {
      request: { ...request, cwd: reserved.projectPath, teamName: physical.executionTeamName },
      mapProgress: (progress, deliver) => {
        const logicalProgress = { ...progress, teamName: address.logicalTeamName };
        if (progress.state !== 'ready') {
          deliver(logicalProgress);
          return;
        }
        void parts.resolver.confirmProvisionedContext(canonicalAddress, physical.executionTeamName)
          .then(() => deliver(logicalProgress))
          .catch((error: unknown) => {
            deliver({
              ...logicalProgress,
              state: 'failed',
              message: 'Could not verify the project runtime context',
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
    };
  } catch (error) {
    // Only an empty, unmaterialized reservation may be forgotten. Retain any
    // physical state for explicit reconciliation after crash or partial launch.
    await parts.registry.releaseUnusedReservation(
      address.logicalTeamName, reserved.executionTeamName, reserved.workContextId
    ).catch(() => false);
    throw error;
  }
}

/** Preserve physical runtime status for controllers; map only UI notifications. */
export function buildTeamProgressReporter(
  noteRuntime: (progress: TeamProvisioningProgress) => void,
  sendToUi: (progress: TeamProvisioningProgress) => void,
  mapper?: ProjectContextProgressMapper
): (progress: TeamProvisioningProgress) => void {
  return (progress) => {
    noteRuntime(progress);
    if (mapper) mapper(progress, sendToUi);
    else sendToUi(progress);
  };
}

/** Resolve only when needed, preserving the existing native launch path. */
export async function withPreparedContextLaunch(
  request: TeamLaunchRequest,
  ports: ProjectTeamRuntimePorts,
  invoke: (request: TeamLaunchRequest, mapper?: ProjectContextProgressMapper) =>
    Promise<IpcResult<TeamLaunchResponse>>
): Promise<IpcResult<TeamLaunchResponse> | null> {
  // Validate explicit overrides BEFORE reserving native files. The original
  // IPC handler still validates effective persisted settings before spawn.
  // A missing provider override inherits the saved provider; Codex and
  // Anthropic support levels beyond the legacy default set.
  const saved = request.providerId ? null : await ports.data.getSavedRequest(request.teamName);
  const effort = parseOptionalTeamEffort(request.effort, request.providerId ?? saved?.providerId);
  if (!effort.valid) throw new Error(effort.error);
  const fastMode = parseOptionalTeamFastMode(request.fastMode);
  if (!fastMode.valid) throw new Error(fastMode.error);
  const selected = await prepareTeamContextLaunch(request, ports);
  if (selected.request.teamName === request.teamName) return null;
  const result = await invoke(selected.request, selected.mapProgress);
  if (result.success && result.data) {
    rememberProjectRunIdentity(
      result.data.runId, request.teamName, selected.request.teamName
    );
  }
  return result;
}
