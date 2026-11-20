import {
  classifyTeamKind,
  launchInProjectContext,
  TeamProjectContextLaunchRefusedError,
} from '@features/team-project-context/main';

import { createProjectContextRuntimeParts } from './ipc/teams/teamProjectContextCreate';
import { projectContextLaunchPorts } from './ipc/teams/teamProjectContextLaunch';
import { projectPublicProvisioningProgress } from './ipc/teams/teamProjectContextProgressIdentity';

import type { ProjectTeamRuntimePorts } from './ipc/teams/teamProjectContextCreate';
import type { ProjectTeamLaunch } from '@features/team-project-context/main';

/**
 * `prepare` refuses a broken invariant of a project copy with a plain `Error`
 * (the app shows its text). For HTTP that is a refusal, not a crash. System
 * errors (they carry an errno `code`) and programming errors stay as they are.
 */
function asLaunchRefusal(error: unknown): never {
  if (error instanceof Error && error.constructor === Error && !('code' in error)) {
    throw new TeamProjectContextLaunchRefusedError(error.message, { cause: error });
  }
  throw error;
}

/**
 * The launch of a team with separate history per project for the HTTP control
 * API (and MCP through it): the same runtime parts, gate and use case as the
 * desktop launch. One instance per request.
 */
export function createProjectTeamLaunch(ports: ProjectTeamRuntimePorts): ProjectTeamLaunch {
  const parts = createProjectContextRuntimeParts(ports);
  const launchPorts = projectContextLaunchPorts(ports, parts);
  return {
    classify: (teamName) => classifyTeamKind(parts.kinds, teamName),
    inspectCopy: (logicalTeamName, projectPath) =>
      parts.registry.inspect(logicalTeamName, projectPath),
    withTeamLock: (teamName, operation) =>
      ports.data.runConfigurationOperation(teamName, operation),
    launch: (request, launcher) =>
      launchInProjectContext(
        request,
        { ...launchPorts, prepare: (copy) => launchPorts.prepare(copy).catch(asLaunchRefusal) },
        launcher
      ),
    publicProgress: projectPublicProvisioningProgress,
  };
}

/** For the HTTP services: the data and provisioning of this app, a fresh port per request. */
export function projectTeamLaunchFactory(
  data: ProjectTeamRuntimePorts['data'],
  provisioning: ProjectTeamRuntimePorts['runtime'] & ProjectTeamRuntimePorts['run']
): () => ProjectTeamLaunch {
  return () => createProjectTeamLaunch({ data, runtime: provisioning, run: provisioning });
}
