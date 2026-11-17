import { createProjectContextRuntimeParts } from './teamProjectContextCreate';

import type { ProjectTeamRuntimePorts } from './teamProjectContextCreate';
import type { TeamLaunchRequest, TeamProvisioningProgress } from '@shared/types';

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
  ports: ProjectTeamRuntimePorts
): Promise<PreparedTeamContextLaunch> {
  const parts = createProjectContextRuntimeParts(ports);
  const mode = await parts.resolver.getMode(request.teamName);
  if (mode === 'shared') return { request };

  const address = { logicalTeamName: request.teamName, projectPath: request.cwd };
  const reserved = await parts.resolver.reserveForProvisioning(address);
  if (!reserved.workContextId) throw new Error('Missing project context identity');

  try {
    await parts.gate.assertOtherContextsStopped(
      address.logicalTeamName, reserved.executionTeamName
    );
    const physical = await parts.materializer.ensureProjectDraft(address);
    if (physical.executionTeamName !== reserved.executionTeamName) {
      throw new Error('Project context changed during launch admission');
    }
    return {
      request: { ...request, teamName: physical.executionTeamName },
      mapProgress: (progress, deliver) => {
        const logicalProgress = { ...progress, teamName: address.logicalTeamName };
        if (progress.state !== 'ready') {
          deliver(logicalProgress);
          return;
        }
        void parts.resolver.confirmProvisionedContext(address, physical.executionTeamName)
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
