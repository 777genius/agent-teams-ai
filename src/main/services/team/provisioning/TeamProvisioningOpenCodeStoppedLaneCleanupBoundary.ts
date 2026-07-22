import { killProcessByPid } from '@main/utils/processKill';

import { isOpenCodeServeCommand } from '../opencode/bridge/OpenCodeManagedHostProcessCleanup';

import {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
  hasAlivePersistedTeamProcess,
  hasOnlyExplicitlyStoppedPersistedTeamProcesses,
  readProcessCommandByPid,
  stopOpenCodeRuntimeLanesForStoppedTeam,
  stopOpenCodeRuntimeLanesForStoppedTeamOnce,
  type StopOpenCodeRuntimeLanesForStoppedTeamPorts,
  tryStopPersistedOpenCodeRuntimePidForStoppedLane,
} from './TeamProvisioningOpenCodeRuntimeLaneCleanup';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

export interface TeamProvisioningOpenCodeStoppedLaneCleanupPorts {
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readPreviousLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readConfigForObservation(teamName: string): Promise<TeamConfig | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  readPersistedTeamProjectPath(teamName: string): string | null;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearPrimaryRuntimeRun(teamName: string): void;
  markStoppedTeamOpenCodeRuntimeLanesCleaned(teamName: string): void;
  logInfo(message: string): void;
  logWarning(message: string): void;
}

export interface TeamProvisioningOpenCodeStoppedLaneCleanupBoundary {
  hasAlivePersistedTeamProcess(teamName: string): boolean;
  hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName: string): boolean;
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  stopOpenCodeRuntimeLanesForStoppedTeam(teamName: string): Promise<number>;
}

export interface TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryHelpers {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: typeof cleanupStoppedTeamOpenCodeRuntimeLanesInBackground;
  hasAlivePersistedTeamProcess: typeof hasAlivePersistedTeamProcess;
  hasOnlyExplicitlyStoppedPersistedTeamProcesses: typeof hasOnlyExplicitlyStoppedPersistedTeamProcesses;
  stopOpenCodeRuntimeLanesForStoppedTeam: typeof stopOpenCodeRuntimeLanesForStoppedTeam;
  stopOpenCodeRuntimeLanesForStoppedTeamOnce: typeof stopOpenCodeRuntimeLanesForStoppedTeamOnce;
  tryStopPersistedOpenCodeRuntimePidForStoppedLane: typeof tryStopPersistedOpenCodeRuntimePidForStoppedLane;
  readProcessCommandByPid: typeof readProcessCommandByPid;
  isOpenCodeServeCommand: typeof isOpenCodeServeCommand;
  killProcessByPid: typeof killProcessByPid;
}

export interface TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps {
  getTeamsBasePath(): string;
  helpers?: Partial<TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryHelpers>;
}

const defaultHelpers: TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryHelpers = {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
  hasAlivePersistedTeamProcess,
  hasOnlyExplicitlyStoppedPersistedTeamProcesses,
  stopOpenCodeRuntimeLanesForStoppedTeam,
  stopOpenCodeRuntimeLanesForStoppedTeamOnce,
  tryStopPersistedOpenCodeRuntimePidForStoppedLane,
  readProcessCommandByPid,
  isOpenCodeServeCommand,
  killProcessByPid,
};

export function createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(
  ports: TeamProvisioningOpenCodeStoppedLaneCleanupPorts,
  deps: TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryDeps
): TeamProvisioningOpenCodeStoppedLaneCleanupBoundary {
  const helpers = {
    ...defaultHelpers,
    ...deps.helpers,
  };
  const inFlight = new Map<string, Promise<number>>();

  const stopInternal = async (teamName: string): Promise<number> =>
    await helpers.stopOpenCodeRuntimeLanesForStoppedTeam({
      teamName,
      teamsBasePath: deps.getTeamsBasePath(),
      ports: createStopPorts(ports, helpers),
    });

  const stopOpenCodeRuntimeLanesForStoppedTeamBoundary = (teamName: string): Promise<number> =>
    helpers.stopOpenCodeRuntimeLanesForStoppedTeamOnce({
      teamName,
      inFlight,
      stopInternal,
    });

  return {
    hasAlivePersistedTeamProcess(teamName) {
      return helpers.hasAlivePersistedTeamProcess({
        teamsBasePath: deps.getTeamsBasePath(),
        teamName,
      });
    },

    hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName) {
      return helpers.hasOnlyExplicitlyStoppedPersistedTeamProcesses({
        teamsBasePath: deps.getTeamsBasePath(),
        teamName,
      });
    },

    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName) {
      helpers.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground({
        teamName,
        stopOpenCodeRuntimeLanesForStoppedTeam: stopOpenCodeRuntimeLanesForStoppedTeamBoundary,
        logWarning: ports.logWarning,
      });
    },

    stopOpenCodeRuntimeLanesForStoppedTeam: stopOpenCodeRuntimeLanesForStoppedTeamBoundary,
  };
}

function createStopPorts(
  ports: TeamProvisioningOpenCodeStoppedLaneCleanupPorts,
  helpers: TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryHelpers
): StopOpenCodeRuntimeLanesForStoppedTeamPorts {
  return {
    canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
      ports.canDeliverToOpenCodeRuntimeForTeam(teamName),
    getOpenCodeRuntimeAdapter: () => ports.getOpenCodeRuntimeAdapter(),
    readPreviousLaunchState: (teamName) => ports.readPreviousLaunchState(teamName),
    readConfigForObservation: (teamName) => ports.readConfigForObservation(teamName),
    readMembersMeta: (teamName) => ports.readMembersMeta(teamName),
    readPersistedTeamProjectPath: (teamName) => ports.readPersistedTeamProjectPath(teamName),
    tryStopPersistedOpenCodeRuntimePidForStoppedLane: (input) =>
      helpers.tryStopPersistedOpenCodeRuntimePidForStoppedLane(input, {
        readProcessCommandByPid: helpers.readProcessCommandByPid,
        isOpenCodeServeCommand: helpers.isOpenCodeServeCommand,
        killProcessByPid: helpers.killProcessByPid,
        logInfo: ports.logInfo,
        logWarning: ports.logWarning,
      }),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      ports.deleteSecondaryRuntimeRun(teamName, laneId),
    clearPrimaryRuntimeRun: (teamName) => ports.clearPrimaryRuntimeRun(teamName),
    markStoppedTeamOpenCodeRuntimeLanesCleaned: (teamName) =>
      ports.markStoppedTeamOpenCodeRuntimeLanesCleaned(teamName),
    logWarning: ports.logWarning,
  };
}
