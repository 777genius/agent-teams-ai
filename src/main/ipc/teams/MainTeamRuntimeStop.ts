import { addMainBreadcrumb } from '@main/sentry';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { TeamLaunchStopAuthority } from '@main/services/team/TeamLaunchStateStore';
import type { TeamForceStopResult } from '@shared/types';

interface RuntimeStopSource {
  getAliveTeams(): string[];
  stopTeam(teamName: string): Promise<void>;
}

interface RuntimeStopLogger {
  info(message: string): void;
  warn(message: string): void;
}

const FORCE_STOP_TIMEOUT_MS = 15_000;
const REGULAR_STOP_TIMEOUT_MS = 90_000;

export class MainTeamRuntimeStop {
  constructor(
    private readonly runtime: RuntimeStopSource,
    private readonly logger: RuntimeStopLogger
  ) {}

  async stopTeam(teamName: string): Promise<void> {
    const { stopTeamWithEscalation } = await import(
      '@main/services/team/lifecycle/teamForceStopFlow'
    );
    const result = await stopTeamWithEscalation(
      teamName,
      this.createPorts(REGULAR_STOP_TIMEOUT_MS)
    );
    if (result.stopOutcome === 'runtime_already_down') {
      this.logger.info(
        `[${teamName}] Runtime hosts were already down; finished the stop without the orchestrator acknowledgement (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
      );
    } else if (result.stopOutcome !== 'stopped') {
      this.logger.warn(
        `[${teamName}] Regular stop ${result.stopOutcome}; escalated to force stop (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
      );
    }
  }

  async forceStopTeam(teamName: string): Promise<TeamForceStopResult> {
    addMainBreadcrumb('team', 'forceStop', { teamName });
    const { runTeamForceStopFlow } = await import(
      '@main/services/team/lifecycle/teamForceStopFlow'
    );
    return runTeamForceStopFlow(teamName, this.createPorts(FORCE_STOP_TIMEOUT_MS));
  }

  private createPorts(stopTimeoutMs: number) {
    return {
      stopTeam: (teamName: string) => this.runtime.stopTeam(teamName),
      observeOwnedRuntimeRunIds: async (teamName: string) => {
        const { readOwnedOpenCodeRuntimeRunIdsForTeam } = await import(
          '@main/services/team/lifecycle/teamForceStopFlow'
        );
        return readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName });
      },
      observeOwnedRuntimeLaneIds: async (teamName: string) => {
        const { readOpenCodeRuntimeLaneIdsForTeam } = await import(
          '@main/services/team/lifecycle/teamForceStopFlow'
        );
        return readOpenCodeRuntimeLaneIdsForTeam(getTeamsBasePath(), teamName);
      },
      killRetainedRuntimeProcesses: async (
        teamName: string,
        context: { requestedAtMs: number }
      ) => {
        const { killRetainedOpenCodeRuntimeProcessesForTeam } = await import(
          '@main/services/team/lifecycle/teamForceStopFlow'
        );
        return killRetainedOpenCodeRuntimeProcessesForTeam({
          teamName,
          requestedAtMs: context.requestedAtMs,
          otherAliveTeams: this.otherAliveTeams(teamName),
        });
      },
      clearPendingPromptDeliveries: async (
        teamName: string,
        context: {
          requestedAtMs: number;
          ownedRunIds: readonly string[];
          ownedLaneIds?: readonly string[];
        }
      ) => {
        const { clearPendingOpenCodePromptDeliveriesForTeam } = await import(
          '@main/services/team/lifecycle/teamForceStopFlow'
        );
        return clearPendingOpenCodePromptDeliveriesForTeam({ teamName, ...context });
      },
      logWarning: (message: string) => this.logger.warn(message),
      stopTimeoutMs,
      countLiveRuntimeHosts: async (teamName: string) => {
        const { countLiveRecordedRuntimeHostsForTeam } = await import(
          '@main/services/team/lifecycle/teamForceStopFlow'
        );
        return countLiveRecordedRuntimeHostsForTeam({ teamName });
      },
      markTeamStopped: async (
        teamName: string,
        authority: TeamLaunchStopAuthority
      ) => {
        const { TeamLaunchStateStore } = await import(
          '@main/services/team/TeamLaunchStateStore'
        );
        return new TeamLaunchStateStore().markStopped(teamName, authority);
      },
      reapOwnedLeadProcessTrees: async (
        teamName: string,
        context: { requestedAtMs: number }
      ) => {
        const { reapCursorAgentLeadTreesForStoppedTeam } = await import(
          '@main/services/team/lifecycle/teamLeadProcessTreeReap'
        );
        return reapCursorAgentLeadTreesForStoppedTeam({
          teamName,
          requestedAtMs: context.requestedAtMs,
          otherAliveTeams: this.otherAliveTeams(teamName),
        });
      },
      releaseSharedRuntimeResources: async (teamName: string) => {
        const {
          releaseLoopbackRuntimesReservedByTeam,
          releaseSharedRuntimeResourcesAfterStop,
        } = await import('@main/services/team/lifecycle/teamForceStopFlow');
        return releaseSharedRuntimeResourcesAfterStop({
          teamName,
          otherAliveTeams: this.otherAliveTeams(teamName),
          releaseSharedLocalRuntime: () =>
            releaseLoopbackRuntimesReservedByTeam(getTeamsBasePath(), teamName),
        });
      },
    };
  }

  private otherAliveTeams(teamName: string): string[] {
    return this.runtime.getAliveTeams().filter((aliveTeam) => aliveTeam !== teamName);
  }
}
