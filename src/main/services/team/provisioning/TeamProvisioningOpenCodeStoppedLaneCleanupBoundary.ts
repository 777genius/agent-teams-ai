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
import {
  createOpenCodeStoppedLaneStopBackoff,
  type OpenCodeStoppedLaneStopBackoff,
} from './TeamProvisioningOpenCodeStoppedLaneStopBackoff';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

export interface TeamProvisioningOpenCodeStoppedLaneCleanupPorts {
  withTeamLock<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  isManagedByThisProfile(teamName: string): Promise<boolean>;
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
  /** Background passes only: lane runs left unconfirmed recently are not retried. */
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  /** Background passes only: lane runs left unconfirmed recently are not retried. */
  stopOpenCodeRuntimeLanesForStoppedTeam(teamName: string): Promise<number>;
  /**
   * Forget the unconfirmed-stop backoff of a team, so the next background pass
   * tries its lanes again at once. Called after the team was moved to the trash.
   * Explicit Stop, relaunch and trash never go through the background entry
   * points above, so they are not held back by the backoff in the first place.
   */
  clearStopBackoff(teamName: string): void;
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
  /** Clock for the unconfirmed-stop backoff; tests pass their own. */
  nowMs?: () => number;
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
  const stopBackoff = createOpenCodeStoppedLaneStopBackoff({
    nowMs: deps.nowMs ?? (() => Date.now()),
  });

  const stopInternal = async (teamName: string): Promise<number> =>
    await helpers.stopOpenCodeRuntimeLanesForStoppedTeam({
      teamName,
      teamsBasePath: deps.getTeamsBasePath(),
      ports: createStopPorts(ports, helpers, stopBackoff),
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

    clearStopBackoff(teamName) {
      stopBackoff.clearTeam(teamName);
    },
  };
}

function createStopPorts(
  ports: TeamProvisioningOpenCodeStoppedLaneCleanupPorts,
  helpers: TeamProvisioningOpenCodeStoppedLaneCleanupBoundaryHelpers,
  stopBackoff: OpenCodeStoppedLaneStopBackoff
): StopOpenCodeRuntimeLanesForStoppedTeamPorts {
  return {
    withTeamLock: (teamName, operation) => ports.withTeamLock(teamName, operation),
    isManagedByThisProfile: (teamName) => ports.isManagedByThisProfile(teamName),
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
    stopBackoff,
    logWarning: ports.logWarning,
  };
}
