import {
  assertOptionalEffort,
  assertOptionalFastMode,
} from '@main/services/team/TeamRequestValidation';

import type { TeamKind } from '../contracts';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

/** Maps the progress of a copy's run to its team; confirms the copy once it is ready. */
export type ProjectContextProgressMapper = (
  progress: TeamProvisioningProgress,
  deliver: (progress: TeamProvisioningProgress) => void
) => void;

export interface PreparedProjectContextLaunch {
  request: TeamLaunchRequest;
  mapProgress?: ProjectContextProgressMapper;
  /** Saves the launch settings of `request` for the team and its copy; a no-op unless the run is fresh. */
  recordLaunch?: (response: TeamLaunchResponse) => Promise<void>;
}

export interface ProjectContextLaunchPorts {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  /**
   * Reserve or reuse the copy of `request.cwd`, check the launch gate and
   * materialize the copy. Any team that is not a logical one comes back as it is.
   */
  prepare(request: TeamLaunchRequest): Promise<PreparedProjectContextLaunch>;
  rememberRunIdentity(runId: string, logicalTeamName: string, executionTeamName: string): void;
}

/** How a transport launches the chosen project copy through its own native launch path. */
export interface ProjectCopyLauncher<T> {
  /** Launch `request` (the copy, with the canonical project path); progress goes through `mapper`. */
  invoke(request: TeamLaunchRequest, mapper?: ProjectContextProgressMapper): Promise<T>;
  /** The run the launch started, or null when it did not start one. */
  started(result: T): TeamLaunchResponse | null;
}

/**
 * The one launch path of a team with separate history per project, for every
 * transport (the desktop IPC, HTTP and MCP): the logical team is launched as
 * the project copy of `request.cwd`, through the same override check,
 * reservation, launch gate and materializer. Any other team returns null and
 * the caller launches it natively. The caller holds the logical-team
 * configuration lock.
 */
export async function launchInProjectContext<T>(
  request: TeamLaunchRequest,
  ports: ProjectContextLaunchPorts,
  launcher: ProjectCopyLauncher<T>
): Promise<T | null> {
  // Explicit overrides are checked BEFORE native files are reserved, with the
  // parser HTTP uses for the whole body. A missing provider override inherits
  // the saved provider; Codex and Anthropic support levels beyond the legacy set.
  const saved = request.providerId ? null : await ports.getSavedRequest(request.teamName);
  assertOptionalEffort(request.effort, request.providerId ?? saved?.providerId);
  assertOptionalFastMode(request.fastMode);
  const selected = await ports.prepare(request);
  if (selected.request.teamName === request.teamName) return null;
  const result = await launcher.invoke(selected.request, selected.mapProgress);
  const run = launcher.started(result);
  if (run) {
    ports.rememberRunIdentity(run.runId, request.teamName, selected.request.teamName);
    // What this launch stated becomes the team's launch settings, on every transport.
    await selected.recordLaunch?.(run);
  }
  return result;
}

/**
 * What an external transport (HTTP, MCP) needs to launch a team in a project,
 * bound to the runtime of this app. Build one per request: the Claude root can
 * change while the app runs, and the parts are then shared by every step.
 */
export interface ProjectTeamLaunch {
  /** The kind of a team name; fails closed on unreadable metadata. */
  classify(teamName: string): Promise<TeamKind>;
  /** Read-only: the copy of a project, ready or still reserved; never creates one. */
  inspectCopy(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext | null>;
  /** The configuration lock of a team, the one the app holds while it launches. */
  withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  /** Whether a launch (provisioning run) of a physical team is in flight in this app. */
  isLaunching(teamName: string): boolean;
  launch<T>(request: TeamLaunchRequest, launcher: ProjectCopyLauncher<T>): Promise<T | null>;
}
