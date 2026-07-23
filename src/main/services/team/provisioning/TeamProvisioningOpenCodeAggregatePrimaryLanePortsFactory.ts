import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import {
  clearOpenCodeRuntimeLaneStorage as defaultClearOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState as defaultMigrateLegacyOpenCodeRuntimeState,
  setOpenCodeRuntimeActiveRunManifest as defaultSetOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry as defaultUpsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { type LaunchOpenCodeAggregatePrimaryLanePorts } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type { TeamProvisioningProgress } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost {
  prepareFacade: {
    getOpenCodeRuntimeLaunchCwd: LaunchOpenCodeAggregatePrimaryLanePorts['getOpenCodeRuntimeLaunchCwd'];
  };
  persistOpenCodeRuntimeAdapterLaunchResult: LaunchOpenCodeAggregatePrimaryLanePorts['persistOpenCodeRuntimeAdapterLaunchResult'];
  toolApprovalFacade: {
    syncOpenCodeRuntimeToolApprovals: LaunchOpenCodeAggregatePrimaryLanePorts['syncOpenCodeRuntimeToolApprovals'];
  };
  runtimeAdapterRunByTeam: Map<
    string,
    Parameters<LaunchOpenCodeAggregatePrimaryLanePorts['setRuntimeAdapterRunByTeam']>[1]
  >;
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  runtimeAdapterProgressState: {
    setRuntimeAdapterProgress(progress: TeamProvisioningProgress): TeamProvisioningProgress;
  };
  invalidateRuntimeSnapshotCaches(teamName: string): void;
}

export interface TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactoryDeps {
  getTeamsBasePath?: LaunchOpenCodeAggregatePrimaryLanePorts['getTeamsBasePath'];
  migrateLegacyOpenCodeRuntimeState?: LaunchOpenCodeAggregatePrimaryLanePorts['migrateLegacyOpenCodeRuntimeState'];
  upsertOpenCodeRuntimeLaneIndexEntry?: LaunchOpenCodeAggregatePrimaryLanePorts['upsertOpenCodeRuntimeLaneIndexEntry'];
  setOpenCodeRuntimeActiveRunManifest?: LaunchOpenCodeAggregatePrimaryLanePorts['setOpenCodeRuntimeActiveRunManifest'];
  clearOpenCodeRuntimeLaneStorage?: LaunchOpenCodeAggregatePrimaryLanePorts['clearOpenCodeRuntimeLaneStorage'];
  logWarning?: LaunchOpenCodeAggregatePrimaryLanePorts['logWarning'];
}

export function createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService(
  service: TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost,
  deps: TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactoryDeps = {}
): LaunchOpenCodeAggregatePrimaryLanePorts {
  return {
    getTeamsBasePath: deps.getTeamsBasePath ?? getDefaultTeamsBasePath,
    getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
      service.prepareFacade.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
    migrateLegacyOpenCodeRuntimeState:
      deps.migrateLegacyOpenCodeRuntimeState ?? defaultMigrateLegacyOpenCodeRuntimeState,
    upsertOpenCodeRuntimeLaneIndexEntry:
      deps.upsertOpenCodeRuntimeLaneIndexEntry ?? defaultUpsertOpenCodeRuntimeLaneIndexEntry,
    setOpenCodeRuntimeActiveRunManifest:
      deps.setOpenCodeRuntimeActiveRunManifest ?? defaultSetOpenCodeRuntimeActiveRunManifest,
    clearOpenCodeRuntimeLaneStorage:
      deps.clearOpenCodeRuntimeLaneStorage ?? defaultClearOpenCodeRuntimeLaneStorage,
    persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
      service.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
    syncOpenCodeRuntimeToolApprovals: (input) =>
      service.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals(input),
    setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
      service.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
    },
    getRuntimeAdapterRunByTeam: (teamName) => service.runtimeAdapterRunByTeam.get(teamName),
    deleteRuntimeAdapterRunByTeamIfOwned: (teamName, expectedOwner) => {
      if (service.runtimeAdapterRunByTeam.get(teamName) !== expectedOwner) {
        return false;
      }
      service.runtimeAdapterRunByTeam.delete(teamName);
      return true;
    },
    publishRuntimeAdapterStopState: (input) => {
      const updatedAt = new Date().toISOString();
      const previous = service.runtimeAdapterProgressByRunId.get(input.runId);
      service.runtimeAdapterProgressState.setRuntimeAdapterProgress({
        ...(previous ?? {
          runId: input.runId,
          teamName: input.teamName,
          startedAt: updatedAt,
          updatedAt,
        }),
        state: input.state,
        message: input.message,
        messageSeverity: input.state === 'failed' ? 'error' : undefined,
        updatedAt,
      });
      service.invalidateRuntimeSnapshotCaches(input.teamName);
    },
    logWarning: deps.logWarning ?? ((message) => logger.warn(message)),
  };
}
