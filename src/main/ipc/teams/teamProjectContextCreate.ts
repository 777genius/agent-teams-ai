import {
  TeamProjectContextCreateCoordinator,
  TeamProjectContextDraftMaterializer,
  TeamProjectContextLaunchGate,
  TeamProjectContextRegistry,
  TeamProjectContextRuntimeResolver,
} from '@features/team-project-context/main';
import {
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'node:path';

import type { TeamDataService } from '@main/services/team/TeamDataService';
import type {
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
} from '@shared/types';

/**
 * The Electron transport is one of the application boundaries. Keep project
 * routing here rather than rewriting native controller/task/chat internals.
 */
export async function createTeamWithProjectContext(
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void,
  ports: {
    data: Pick<TeamDataService, 'createTeamConfig' | 'getSavedRequest' | 'runConfigurationOperation'>;
    start: Pick<TeamProvisioningStartApi, 'createTeam'>;
    runtime: Pick<TeamRuntimeApi, 'getRuntimeState'>;
    run: Pick<TeamProvisioningRunApi, 'hasProvisioningRun'>;
    watchNativeTeam(teamName: string): void;
  }
): Promise<TeamCreateResponse> {
  if (request.projectContextMode !== 'per_project') {
    return ports.start.createTeam(request, onProgress);
  }
  const registry = TeamProjectContextRegistry.fromCurrentApp();
  const resolver = new TeamProjectContextRuntimeResolver(ports.data, registry);
  const materializer = new TeamProjectContextDraftMaterializer(resolver, {
    getSavedRequest: (teamName) => ports.data.getSavedRequest(teamName),
    createTeamConfig: (config) => ports.data.createTeamConfig(config),
    assertOwnedAlias: async (teamName) => {
      const owner = await readTeamOwnerProfileScope(path.join(getTeamsBasePath(), teamName));
      if (owner !== resolveThisAppProfileScope()) {
        throw new Error('Unowned project context: refusing native launch');
      }
    },
  });
  const gate = new TeamProjectContextLaunchGate(registry, {
    getRuntimeState: (teamName) => ports.runtime.getRuntimeState(teamName),
    hasProvisioningRun: (teamName) => ports.run.hasProvisioningRun(teamName),
  });
  const coordinator = new TeamProjectContextCreateCoordinator({
    createLogicalDraft: (creation) => ports.data.createTeamConfig(creation),
    withLogicalTeamLock: (teamName, operation) =>
      ports.data.runConfigurationOperation(teamName, operation),
    reserve: (address) => resolver.reserveForProvisioning(address),
    releaseUnusedReservation: (name, execution, id) =>
      registry.releaseUnusedReservation(name, execution, id),
    assertOtherContextsStopped: (name, execution) =>
      gate.assertOtherContextsStopped(name, execution),
    ensurePhysicalDraft: (address) => materializer.ensureProjectDraft(address),
    createNativeTeam: (creation, report) => {
      ports.watchNativeTeam(creation.teamName);
      return ports.start.createTeam(creation, report);
    },
    confirmReady: (address, execution) =>
      resolver.confirmProvisionedContext(address, execution),
  });
  return coordinator.create(request, onProgress);
}
