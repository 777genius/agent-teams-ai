import { KillTeamProcess } from '../../core/application/use-cases/KillTeamProcess';
import { ManageTeamRuntimeLifecycle } from '../../core/application/use-cases/ManageTeamRuntimeLifecycle';
import { ReadTeamRuntimeDiagnostics } from '../../core/application/use-cases/ReadTeamRuntimeDiagnostics';
import { ReadTeamRuntimeLogs } from '../../core/application/use-cases/ReadTeamRuntimeLogs';
import { MainTeamRuntimeEffects } from '../adapters/output/MainTeamRuntimeEffects';
import { MainTeamTaskLogWorker } from '../adapters/output/MainTeamTaskLogWorker';

import type {
  TeamMemberSpawnStatusPort,
  TeamRuntimeDiagnosticsPort,
  TeamRuntimeEffectsPort,
  TeamRuntimeFeedPort,
  TeamRuntimeLifecycleCommandPort,
  TeamRuntimeLivenessPort,
  TeamRuntimeLoggerPort,
  TeamRuntimeLogsPort,
  TeamRuntimeMessagingPort,
  TeamRuntimeProcessPort,
  TeamRuntimeStatusPort,
  TeamRuntimeStopPort,
  TeamTaskLogWorkerPort,
} from '../../core/application/ports/TeamRuntimeOperationPorts';
import type { MemberStatsComputer, TeamDataService, TeamMemberLogsFinder } from '@main/services';
import type {
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamMemberLifecycleApi,
  TeamMessagingApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

export interface TeamRuntimeOperationsFeature {
  logs: ReadTeamRuntimeLogs;
  diagnostics: ReadTeamRuntimeDiagnostics;
  lifecycle: ManageTeamRuntimeLifecycle;
  killProcess: KillTeamProcess;
  logger: TeamRuntimeLoggerPort;
}

export function createTeamRuntimeOperationsFeature(dependencies: {
  data: Pick<TeamDataService, 'getTeamData' | 'invalidateMessageFeed' | 'killProcess'>;
  runtime: Pick<TeamRuntimeApi, 'getAliveTeams' | 'isTeamAlive' | 'stopTeam'>;
  lifecycle: Pick<
    TeamMemberLifecycleApi,
    | 'getMemberSpawnStatuses'
    | 'restartMember'
    | 'retryFailedOpenCodeSecondaryLanes'
    | 'skipMemberForLaunch'
  >;
  diagnostics: TeamDiagnosticsApi;
  claudeLogs: TeamClaudeLogsApi;
  messaging: Pick<TeamMessagingApi, 'sendMessageToTeam'>;
  logsFinder: TeamMemberLogsFinder;
  statsComputer: MemberStatsComputer;
  logger: TeamRuntimeLoggerPort;
  worker?: TeamTaskLogWorkerPort;
  effects?: TeamRuntimeEffectsPort;
}): TeamRuntimeOperationsFeature {
  const logs: TeamRuntimeLogsPort = {
    getClaudeLogs: (teamName, query) => dependencies.claudeLogs.getClaudeLogs(teamName, query),
    findMemberLogs: (teamName, memberName) =>
      dependencies.logsFinder.findMemberLogs(teamName, memberName),
    findLogsForTask: (teamName, taskId, options) =>
      dependencies.logsFinder.findLogsForTask(teamName, taskId, options),
    getMemberStats: (teamName, memberName) =>
      dependencies.statsComputer.getStats(teamName, memberName),
  };
  const runtime: TeamRuntimeStatusPort & TeamRuntimeStopPort & TeamRuntimeLivenessPort = {
    getAliveTeams: () => dependencies.runtime.getAliveTeams(),
    isTeamAlive: (teamName) => dependencies.runtime.isTeamAlive(teamName),
    stopTeam: (teamName) => dependencies.runtime.stopTeam(teamName),
  };
  const lifecycle: TeamMemberSpawnStatusPort & TeamRuntimeLifecycleCommandPort = {
    getMemberSpawnStatuses: (teamName) => dependencies.lifecycle.getMemberSpawnStatuses(teamName),
    restartMember: (teamName, memberName) =>
      dependencies.lifecycle.restartMember(teamName, memberName),
    retryFailedOpenCodeSecondaryLanes: (teamName) =>
      dependencies.lifecycle.retryFailedOpenCodeSecondaryLanes(teamName),
    skipMemberForLaunch: (teamName, memberName) =>
      dependencies.lifecycle.skipMemberForLaunch(teamName, memberName),
  };
  const diagnostics: TeamRuntimeDiagnosticsPort = {
    getLeadActivityState: (teamName) => dependencies.diagnostics.getLeadActivityState(teamName),
    getLeadContextUsage: (teamName) => dependencies.diagnostics.getLeadContextUsage(teamName),
    getTeamAgentRuntimeSnapshot: (teamName) =>
      dependencies.diagnostics.getTeamAgentRuntimeSnapshot(teamName),
  };
  const feed: TeamRuntimeFeedPort = {
    invalidateMessageFeed: (teamName) => dependencies.data.invalidateMessageFeed(teamName),
  };
  const processes: TeamRuntimeProcessPort = {
    findProcess: async (teamName, pid) => {
      const data = await dependencies.data.getTeamData(teamName);
      const process = data.processes?.find((candidate) => candidate.pid === pid);
      return process ? { label: process.label, port: process.port } : null;
    },
    killProcess: (teamName, pid) => dependencies.data.killProcess(teamName, pid),
  };
  const messaging: TeamRuntimeMessagingPort = {
    sendMessageToTeam: (teamName, message) =>
      dependencies.messaging.sendMessageToTeam(teamName, message),
  };
  const worker = dependencies.worker ?? new MainTeamTaskLogWorker();
  const effects = dependencies.effects ?? new MainTeamRuntimeEffects();

  return {
    logs: new ReadTeamRuntimeLogs(logs, worker, dependencies.logger),
    diagnostics: new ReadTeamRuntimeDiagnostics(runtime, diagnostics, lifecycle),
    lifecycle: new ManageTeamRuntimeLifecycle(lifecycle, runtime, feed, effects),
    killProcess: new KillTeamProcess(processes, runtime, messaging, dependencies.logger),
    logger: dependencies.logger,
  };
}
