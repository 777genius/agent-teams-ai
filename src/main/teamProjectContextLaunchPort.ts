import { classifyTeamKind, launchInProjectContext } from '@features/team-project-context/main';

// The runtime parts and `prepareTeamContextLaunch` are application code that still lives in the
// IPC folder; moving them into the feature (main) is the next cleanup. This module is the one
// place outside the IPC layer that composes them.
import { createProjectContextRuntimeParts } from './ipc/teams/teamProjectContextCreate';
import { projectContextLaunchPorts } from './ipc/teams/teamProjectContextLaunch';

import type { ProjectTeamRuntimePorts } from './ipc/teams/teamProjectContextCreate';
import type { ProjectTeamLaunch } from '@features/team-project-context/main';

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
    launch: (request, launcher) => launchInProjectContext(request, launchPorts, launcher),
  };
}

/** For the HTTP services: the data and provisioning of this app, a fresh port per request. */
export function projectTeamLaunchFactory(
  data: ProjectTeamRuntimePorts['data'],
  provisioning: ProjectTeamRuntimePorts['runtime'] & ProjectTeamRuntimePorts['run']
): () => ProjectTeamLaunch {
  return () => createProjectTeamLaunch({ data, runtime: provisioning, run: provisioning });
}
