import {
  classifyTeamKind,
  launchInProjectContext,
  recordLaunchSettings,
  rememberProjectRunIdentity,
  TeamProjectContextLaunchConflictError,
  trackProjectCopyLaunch,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { createLogger } from '@shared/utils/logger';
import { isFreshLaunch } from '@shared/utils/teamLaunchResponse';

import { createProjectContextRuntimeParts } from './teamProjectContextCreate';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type {
  DefinitionLaunchSettingsStore,
  ProjectContextLaunchPorts,
  ProjectContextProgressMapper,
  ProjectCopyLaunch,
} from '@features/team-project-context/main';
import type { IpcResult, TeamLaunchRequest, TeamLaunchResponse, TeamProvisioningProgress } from '@shared/types';

const logger = createLogger('IPC:teams:projectLaunch');

export type { ProjectContextProgressMapper };
export type ProjectContextRuntimeParts = ReturnType<typeof createProjectContextRuntimeParts>;

export interface PreparedTeamContextLaunch {
  request: TeamLaunchRequest;
  mapProgress?: ProjectContextProgressMapper;
  /**
   * Saves what the launch stated as the team's launch settings. Only for a
   * launch the user chose settings for; the caller decides (a schedule runs
   * what the definition says and never records).
   */
  recordLaunch?: (response: TeamLaunchResponse) => Promise<void>;
  /** The launch of a pending copy, tracked from its reservation; the launch use case ends it. */
  launch?: ProjectCopyLaunch;
}

/**
 * Caller holds the logical-team configuration lock and has already checked
 * project path and basic launch request validity. Resolve an existing project
 * (or prepare its draft) before delegating to the unchanged native launch path.
 */
export async function prepareTeamContextLaunch(
  request: TeamLaunchRequest,
  ports: ProjectTeamRuntimePorts,
  options: { expectedExecutionTeamName?: string; parts?: ProjectContextRuntimeParts } = {}
): Promise<PreparedTeamContextLaunch> {
  const parts = options.parts ?? createProjectContextRuntimeParts(ports);
  const kind = await classifyTeamKind(parts.kinds, request.teamName);
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
  // A pending copy counts as being launched from here, before its run exists.
  const launch =
    reserved.state === 'reserved' ? trackProjectCopyLaunch(reserved.executionTeamName) : undefined;
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
      throw new TeamProjectContextLaunchConflictError('Project context changed during launch admission');
    }
    return {
      request: { ...request, cwd: reserved.projectPath, teamName: physical.executionTeamName },
      launch,
      recordLaunch: (response) =>
        recordAcceptedLaunch(parts.launchSettings, request, physical.executionTeamName, response),
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
    launch?.end();
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

/** The ports of the launch use case, bound to this app; `parts` are shared with the caller. */
export function projectContextLaunchPorts(
  ports: ProjectTeamRuntimePorts,
  parts: ProjectContextRuntimeParts = createProjectContextRuntimeParts(ports)
): ProjectContextLaunchPorts {
  return {
    getSavedRequest: (teamName) => ports.data.getSavedRequest(teamName),
    prepare: (request) => prepareTeamContextLaunch(request, ports, { parts }),
    rememberRunIdentity: rememberProjectRunIdentity,
  };
}

/** The desktop IPC adapter: resolve only when needed, preserving the native launch path. */
export function withPreparedContextLaunch(
  request: TeamLaunchRequest,
  ports: ProjectTeamRuntimePorts,
  invoke: (request: TeamLaunchRequest, mapper?: ProjectContextProgressMapper) =>
    Promise<IpcResult<TeamLaunchResponse>>
): Promise<IpcResult<TeamLaunchResponse> | null> {
  return launchInProjectContext(request, projectContextLaunchPorts(ports), {
    invoke,
    started: (result) => (result.success ? (result.data ?? null) : null),
  });
}

/**
 * What the user chose for this launch becomes the team's saved launch
 * settings, like for an ordinary team. A launch that found the team already
 * starting or running applied nothing and records nothing. The launch is
 * already accepted, so a failure to save is logged as an error and never fails
 * it; the next launch records again. The caller holds the logical-team
 * configuration lock.
 */
async function recordAcceptedLaunch(
  store: DefinitionLaunchSettingsStore,
  request: TeamLaunchRequest,
  copyTeamName: string,
  response: TeamLaunchResponse
): Promise<void> {
  if (!isFreshLaunch(response)) return;
  try {
    const { copyFailure } = await recordLaunchSettings(
      store,
      { definition: request.teamName, copy: copyTeamName },
      request
    );
    if (copyFailure) {
      logger.error(
        `Launch settings of ${request.teamName} were saved, but its project copy ${copyTeamName} still has older ones until the next launch: ${copyFailure.message}`
      );
    }
  } catch (error) {
    logger.error(
      `Could not save the launch settings of ${request.teamName}; the next launch will try again: ${String(error)}`
    );
  }
}
