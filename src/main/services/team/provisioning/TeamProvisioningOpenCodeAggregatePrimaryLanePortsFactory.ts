import { getTeamsBasePath as getDefaultTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import {
  migrateLegacyOpenCodeRuntimeState as defaultMigrateLegacyOpenCodeRuntimeState,
  setOpenCodeRuntimeActiveRunManifest as defaultSetOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry as defaultUpsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { type LaunchOpenCodeAggregatePrimaryLanePorts } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';

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
}

export interface TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactoryDeps {
  getTeamsBasePath?: LaunchOpenCodeAggregatePrimaryLanePorts['getTeamsBasePath'];
  migrateLegacyOpenCodeRuntimeState?: LaunchOpenCodeAggregatePrimaryLanePorts['migrateLegacyOpenCodeRuntimeState'];
  upsertOpenCodeRuntimeLaneIndexEntry?: LaunchOpenCodeAggregatePrimaryLanePorts['upsertOpenCodeRuntimeLaneIndexEntry'];
  setOpenCodeRuntimeActiveRunManifest?: LaunchOpenCodeAggregatePrimaryLanePorts['setOpenCodeRuntimeActiveRunManifest'];
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
    persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
      service.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
    syncOpenCodeRuntimeToolApprovals: (input) =>
      service.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals(input),
    setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
      service.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
    },
    logWarning: deps.logWarning ?? ((message) => logger.warn(message)),
  };
}
