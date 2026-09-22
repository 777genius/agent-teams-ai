import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { OpenCodeRuntimeLaneRecoveryPorts } from './TeamProvisioningOpenCodeRuntimeRecoveryFlow';

const defaultLogger = createLogger('Service:TeamProvisioning');

export interface TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost {
  runTracking: {
    canDeliverToOpenCodeRuntimeForTeam: OpenCodeRuntimeLaneRecoveryPorts['canDeliverToOpenCodeRuntimeForTeam'];
    canAttemptCommittedOpenCodeSessionRecovery: OpenCodeRuntimeLaneRecoveryPorts['canAttemptCommittedOpenCodeSessionRecovery'];
  };
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: OpenCodeRuntimeLaneRecoveryPorts['cleanupStoppedTeamOpenCodeRuntimeLanesInBackground'];
  launchStateStore: {
    read: OpenCodeRuntimeLaneRecoveryPorts['readLaunchState'];
  };
  openCodeRuntimeRecoveryBoundary: {
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: OpenCodeRuntimeLaneRecoveryPorts['tryRecoverMissingOpenCodeSecondaryLaneFromRuntime'];
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: OpenCodeRuntimeLaneRecoveryPorts['tryRecoverActiveOpenCodeSecondaryLaneFromRuntime'];
  };
  readOpenCodeMemberDirectory: OpenCodeRuntimeLaneRecoveryPorts['readOpenCodeMemberDirectory'];
  resolveOpenCodeMemberIdentityFromDirectory: OpenCodeRuntimeLaneRecoveryPorts['resolveOpenCodeMemberIdentityFromDirectory'];
  readConfigForObservation: OpenCodeRuntimeLaneRecoveryPorts['readConfigForObservation'];
  teamMetaStore: {
    getMeta: OpenCodeRuntimeLaneRecoveryPorts['readTeamMeta'];
  };
  membersMetaStore: {
    getMembers: OpenCodeRuntimeLaneRecoveryPorts['readMetaMembers'];
  };
  readPersistedTeamProjectPath: OpenCodeRuntimeLaneRecoveryPorts['readPersistedTeamProjectPath'];
  openCodeRuntimeRecoveryIdentity: {
    isOpenCodeRuntimeLaneIndexActive: OpenCodeRuntimeLaneRecoveryPorts['isOpenCodeRuntimeLaneIndexActive'];
  };
}

export interface TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryDeps {
  teamsBasePath?: string;
  logger?: OpenCodeRuntimeLaneRecoveryPorts['logger'];
}

export function createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(
  host: TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost,
  deps: TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryDeps = {}
): OpenCodeRuntimeLaneRecoveryPorts {
  return {
    teamsBasePath: deps.teamsBasePath ?? getTeamsBasePath(),
    logger: deps.logger ?? defaultLogger,
    canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
      host.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
    canAttemptCommittedOpenCodeSessionRecovery: (teamName) =>
      host.runTracking.canAttemptCommittedOpenCodeSessionRecovery(teamName),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      host.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
    readLaunchState: (teamName) => host.launchStateStore.read(teamName),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (recoverInput) =>
      host.openCodeRuntimeRecoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
        recoverInput
      ),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (recoverInput) =>
      host.openCodeRuntimeRecoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
        recoverInput
      ),
    readOpenCodeMemberDirectory: (teamName) => host.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      host.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
    readConfigForObservation: (teamName) => host.readConfigForObservation(teamName),
    readTeamMeta: (teamName) => host.teamMetaStore.getMeta(teamName),
    readMetaMembers: (teamName) => host.membersMetaStore.getMembers(teamName),
    readPersistedTeamProjectPath: (teamName) => host.readPersistedTeamProjectPath(teamName),
    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      host.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
  };
}
