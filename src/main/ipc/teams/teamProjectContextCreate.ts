import * as path from 'node:path';

import {
  createTeamKindPorts,
  isConfirmedStoppedTeamRuntime,
  rememberProjectRunIdentity,
  TeamProjectContextCreateCoordinator,
  TeamProjectContextDraftMaterializer,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextLaunchGate,
  TeamProjectContextLaunchRefusedError,
  TeamProjectContextRegistry,
  TeamProjectContextRuntimeResolver,
} from '@features/team-project-context/main';
import {
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { createLaunchSettingsStore } from './teamLaunchSettingsStore';
import { createLaunchReviewFlowProjection } from './teamReviewFlow';

import type {
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export interface ProjectTeamRuntimePorts {
  data: Pick<
    TeamDataService,
    | 'createTeamConfig'
    | 'getSavedRequest'
    | 'replaceMembers'
    | 'runConfigurationOperation'
    | 'setReviewFlowSettings'
    | 'updateConfig'
  >;
  runtime: Pick<TeamRuntimeApi, 'getRuntimeState'>;
  run: Pick<TeamProvisioningRunApi, 'hasProvisioningRun'>;
}

export interface ProjectTeamCreatePorts extends ProjectTeamRuntimePorts {
  start: Pick<TeamProvisioningStartApi, 'createTeam'>;
  watchNativeTeam(teamName: string): void;
}

export function createProjectContextRuntimeParts(ports: ProjectTeamRuntimePorts) {
  const registry = TeamProjectContextRegistry.fromCurrentApp();
  const resolver = new TeamProjectContextRuntimeResolver(new TeamMetaStore(), registry);
  const launchSettings = createLaunchSettingsStore();
  const materializer = new TeamProjectContextDraftMaterializer(resolver, {
    getSavedRequest: (teamName) => ports.data.getSavedRequest(teamName),
    createTeamConfig: (config, options) => ports.data.createTeamConfig(config, options),
    replaceMembers: (name, request) => ports.data.replaceMembers(name, request),
    updateDisplayMetadata: async (name, update) => {
      await ports.data.updateConfig(name, update);
    },
    launchSettings,
    projectReviewFlow: createLaunchReviewFlowProjection(ports.data),
    assertStoppedForRosterSync: async (name) => {
      if (ports.run.hasProvisioningRun(name) ||
          !isConfirmedStoppedTeamRuntime(await ports.runtime.getRuntimeState(name))) {
        throw new TeamProjectContextLaunchConflictError(
          'Stop this project runtime before applying team roster changes'
        );
      }
    },
    assertOwnedAlias: async (teamName) => {
      const owner = await readTeamOwnerProfileScope(path.join(getTeamsBasePath(), teamName));
      if (owner !== resolveThisAppProfileScope()) {
        throw new TeamProjectContextLaunchRefusedError('Unowned project context: refusing native launch');
      }
    },
  });
  const gate = new TeamProjectContextLaunchGate(registry, {
    getRuntimeState: (teamName) => ports.runtime.getRuntimeState(teamName),
    hasProvisioningRun: (teamName) => ports.run.hasProvisioningRun(teamName),
  });
  return {
    registry,
    resolver,
    materializer,
    gate,
    launchSettings,
    kinds: createTeamKindPorts(resolver, registry),
  };
}

/**
 * The Electron transport is one of the application boundaries. Keep project
 * routing here rather than rewriting native controller/task/chat internals.
 */
export async function createTeamWithProjectContext(
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void,
  ports: ProjectTeamCreatePorts
): Promise<TeamCreateResponse> {
  if (request.projectContextMode !== 'per_project') {
    return ports.start.createTeam(request, onProgress);
  }
  const { registry, resolver, materializer, gate } = createProjectContextRuntimeParts(ports);
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
    createNativeTeam: async (creation, report) => {
      ports.watchNativeTeam(creation.teamName);
      const result = await ports.start.createTeam(creation, report);
      rememberProjectRunIdentity(result.runId, request.teamName, creation.teamName);
      return result;
    },
    confirmReady: (address, execution) =>
      resolver.confirmProvisionedContext(address, execution),
  });
  return coordinator.create(request, onProgress);
}
