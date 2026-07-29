import {
  registerTaskLogObservabilityIpc,
  removeTaskLogObservabilityIpc,
} from '@features/task-log-observability/main';
import {
  createTeamApprovalsFeature,
  registerTeamApprovalsIpc,
  removeTeamApprovalsIpc,
} from '@features/team-approvals/main';
import {
  createTeamConfigurationFeature,
  registerTeamConfigurationIpc,
  removeTeamConfigurationIpc,
} from '@features/team-configuration/main';
import {
  createTeamLifecycleIpcFeature,
  createTeamLifecycleReadIpcFeature,
  registerTeamLifecycleIpc,
  registerTeamLifecycleReadIpc,
  removeTeamLifecycleIpc,
  removeTeamLifecycleReadIpc,
  type TeamLifecycleAtomicCommandPort,
} from '@features/team-lifecycle/main';
import {
  createTeamMessageDeliveryFeature,
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
} from '@features/team-message-delivery/main';
import {
  createTeamProvisioningFeature,
  registerTeamProvisioningIpc,
  removeTeamProvisioningIpc,
} from '@features/team-provisioning/main';
import {
  createTeamRosterMutationFeature,
  registerTeamRosterMutationIpc,
  removeTeamRosterMutationIpc,
} from '@features/team-roster-mutations/main';
import {
  createTeamRuntimeOperationsFeature,
  registerTeamRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc,
} from '@features/team-runtime-operations/main';
import {
  createTeamTaskBoardFeature,
  registerTeamTaskBoardIpc,
  removeTeamTaskBoardIpc,
} from '@features/team-task-board/main';
import {
  createTeamViewReadModelFeature,
  registerTeamViewReadModelIpc,
  removeTeamViewReadModelIpc,
} from '@features/team-view-read-model/main';
import { createLogger } from '@shared/utils/logger';

import { setCurrentMainOp } from '../services/infrastructure/EventLoopLagMonitor';
import { cloneLaunchIoGovernorPayload } from '../services/team/LaunchIoGovernor';
import { getTeamDataWorkerClient } from '../services/team/TeamDataWorkerClient';

import { validateTeamName } from './guards';
import {
  createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository,
  handleListTeamLifecycle,
  initializeTeamHandlers,
  permanentlyDeleteDraftTeam,
  permanentlyDeleteTeam,
  registerTeamHandlers,
  removeTeamHandlers,
} from './teams';

import type {
  BoardTaskActivityDetailService,
  BoardTaskActivityService,
  BoardTaskExactLogDetailService,
  BoardTaskExactLogsService,
  BoardTaskLogStreamService,
  BranchStatusService,
  MemberStatsComputer,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
  TeamMemberLogsFinder,
} from '../services';
import type { LaunchIoGovernor } from '../services/team/LaunchIoGovernor';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { DesktopTeamFeatureCapabilities } from './teamFeatureCapabilities';
import type { IpcMain } from 'electron';

const taskLogObservabilityLogger = createLogger('IPC:teams');
const teamLifecycleIpcLogger = createLogger('IPC:teams');
const teamApprovalsLogger = createLogger('IPC:teamApprovals');
const teamTaskBoardLogger = createLogger('IPC:teamTaskBoard');
const teamViewReadModelLogger = createLogger('IPC:teams');
const teamConfigurationLogger = createLogger('IPC:teams');
const teamMessageDeliveryLogger = createLogger('IPC:teams');
const teamProvisioningLogger = createLogger('IPC:teams');
const teamRosterMutationLogger = createLogger('IPC:teams');
const teamRuntimeOperationsLogger = createLogger('IPC:teams');

interface TeamPermanentDeletionLifecycle {
  prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
}

export interface DesktopTeamFeatureCompositionDependencies {
  teamDataService: TeamDataService;
  capabilities: DesktopTeamFeatureCapabilities;
  teamMemberLogsFinder: TeamMemberLogsFinder;
  memberStatsComputer: MemberStatsComputer;
  boardTaskActivityService: BoardTaskActivityService;
  boardTaskActivityDetailService: BoardTaskActivityDetailService;
  boardTaskLogStreamService: BoardTaskLogStreamService;
  boardTaskExactLogsService: BoardTaskExactLogsService;
  boardTaskExactLogDetailService: BoardTaskExactLogDetailService;
  teammateToolTracker: TeammateToolTracker | undefined;
  teamLogSourceTracker: TeamLogSourceTracker | undefined;
  branchStatusService: BranchStatusService | undefined;
  teamBackupService: TeamBackupService | undefined;
  launchIoGovernor: LaunchIoGovernor | undefined;
  teamPermanentDeletionLifecycle: TeamPermanentDeletionLifecycle | undefined;
}

export interface DesktopTeamFeatureComposition {
  initializeLegacyHandlers(): void;
  register(ipcMain: IpcMain): void;
}

function createLegacyTeamLifecycleCommandAcl(
  dependencies: DesktopTeamFeatureCompositionDependencies
): TeamLifecycleAtomicCommandPort {
  return Object.freeze({
    deleteTeam: async (teamName: string) => {
      await dependencies.capabilities.runtime.stopTeam(teamName);
      await dependencies.teamDataService.deleteTeam(teamName);
      getTeamDataWorkerClient().invalidateTeamConfig(teamName);
    },
    restoreTeam: async (teamName: string) => {
      await dependencies.teamDataService.restoreTeam(teamName);
      getTeamDataWorkerClient().invalidateTeamConfig(teamName);
    },
    permanentlyDeleteTeam,
  });
}

export function createDesktopTeamFeatureComposition(
  dependencies: DesktopTeamFeatureCompositionDependencies
): DesktopTeamFeatureComposition {
  const lifecycleReadIpcFeature = createTeamLifecycleReadIpcFeature({
    legacy: {
      listTeams: () => {
        const loadFresh = () => dependencies.teamDataService.listTeams();
        return dependencies.launchIoGovernor
          ? dependencies.launchIoGovernor.runSummaryOperation('teams:list', loadFresh, {
              clone: cloneLaunchIoGovernorPayload,
            })
          : loadFresh();
      },
    },
    canonical: {
      listTeamLifecycle: (request) => handleListTeamLifecycle(request),
    },
    operations: {
      setCurrent: setCurrentMainOp,
    },
    clock: {
      now: Date.now,
    },
    logger: teamLifecycleIpcLogger,
  });
  const lifecycleIpcFeature = createTeamLifecycleIpcFeature({
    commands: createLegacyTeamLifecycleCommandAcl(dependencies),
    logger: teamLifecycleIpcLogger,
    validateTeamName,
  });
  const lifecycleAwareProvisioningStart = createIdentityFencedProvisioningStart(
    dependencies.capabilities.provisioningStart,
    dependencies.teamBackupService,
    dependencies.teamPermanentDeletionLifecycle
  );
  const teamApprovalsFeature = createTeamApprovalsFeature({
    toolApprovalApi: dependencies.capabilities.toolApproval,
  });
  const teamTaskBoardFeature = createTeamTaskBoardFeature({
    taskBoardApi: dependencies.teamDataService,
    runtimeApi: dependencies.capabilities.runtime,
    notificationApi: dependencies.capabilities.messaging,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamTaskBoardLogger,
  });
  const teamViewReadModelFeature = createTeamViewReadModelFeature({
    data: dependencies.teamDataService,
    provisioningRuns: dependencies.capabilities.provisioningRun,
    taskActivity: dependencies.capabilities.taskActivity,
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.liveLeadMessages,
    logger: teamViewReadModelLogger,
  });
  const teamConfigurationFeature = createTeamConfigurationFeature({
    repository: createIdentityFencedTeamConfigurationRepository(
      dependencies.teamDataService,
      dependencies.teamBackupService,
      dependencies.teamPermanentDeletionLifecycle,
      permanentlyDeleteDraftTeam
    ),
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.messaging,
    logger: teamConfigurationLogger,
  });
  const teamMessageDeliveryFeature = createTeamMessageDeliveryFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.messageDeliveryCompatibility,
    logger: teamMessageDeliveryLogger,
  });
  const teamRosterMutationFeature = createTeamRosterMutationFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.capabilities.runtime,
    lifecycle: dependencies.capabilities.rosterLifecycle,
    messaging: dependencies.capabilities.messaging,
    logger: teamRosterMutationLogger,
  });
  const teamProvisioningFeature = createTeamProvisioningFeature({
    start: lifecycleAwareProvisioningStart,
    status: dependencies.capabilities.provisioningStatus,
    preflight: dependencies.capabilities.preflight,
    provisioningRun: dependencies.capabilities.provisioningRun,
    repository: dependencies.teamDataService,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamProvisioningLogger,
  });
  const runtime = dependencies.capabilities.runtime;
  const lifecycle = dependencies.capabilities.runtimeLifecycle;
  const diagnostics = dependencies.capabilities.runtimeDiagnostics;
  const runtimeLogs = dependencies.capabilities.runtimeLogs;
  const messaging = dependencies.capabilities.messaging;
  const data = dependencies.teamDataService;
  const memberLogs = dependencies.teamMemberLogsFinder;
  const memberStats = dependencies.memberStatsComputer;
  const teamRuntimeOperationsFeature = createTeamRuntimeOperationsFeature({
    logs: {
      getClaudeLogs: (teamName, query) => runtimeLogs.getClaudeLogs(teamName, query),
      getRuntimeLogs: (teamName, query) => runtimeLogs.getClaudeLogs(teamName, query),
      findMemberLogs: (teamName, memberName) => memberLogs.findMemberLogs(teamName, memberName),
      findLogsForTask: (teamName, taskId, options) =>
        memberLogs.findLogsForTask(teamName, taskId, options),
      getMemberStats: (teamName, memberName) => memberStats.getStats(teamName, memberName),
    },
    runtime: {
      getAliveTeams: () => runtime.getAliveTeams(),
      isTeamAlive: (teamName) => runtime.isTeamAlive(teamName),
      stopTeam: (teamName) => runtime.stopTeam(teamName),
    },
    lifecycle,
    diagnostics: {
      getLeadActivityState: (teamName) => diagnostics.getLeadActivityState(teamName),
      getLeadContextUsage: (teamName) => diagnostics.getLeadContextUsage(teamName),
      getTeamAgentRuntimeSnapshot: (teamName) => diagnostics.getTeamAgentRuntimeSnapshot(teamName),
    },
    feed: {
      invalidateMessageFeed: (teamName) => data.invalidateMessageFeed(teamName),
    },
    processes: {
      findProcess: async (teamName, pid) => {
        const teamData = await data.getTeamData(teamName);
        const process = teamData.processes?.find((candidate) => candidate.pid === pid);
        return process ? { label: process.label, port: process.port } : null;
      },
      killProcess: (teamName, pid) => data.killProcess(teamName, pid),
    },
    messaging: {
      sendMessageToTeam: (teamName, message) => messaging.sendMessageToTeam(teamName, message),
    },
    logger: teamRuntimeOperationsLogger,
  });

  return {
    initializeLegacyHandlers(): void {
      initializeTeamHandlers(
        dependencies.teamDataService,
        dependencies.capabilities.runtime,
        dependencies.teamBackupService,
        dependencies.teammateToolTracker,
        dependencies.teamLogSourceTracker,
        dependencies.branchStatusService,
        dependencies.launchIoGovernor,
        dependencies.teamPermanentDeletionLifecycle
      );
    },
    register(ipcMain: IpcMain): void {
      registerTeamHandlers(ipcMain);
      registerTeamLifecycleReadIpc(ipcMain, lifecycleReadIpcFeature);
      registerTeamLifecycleIpc(ipcMain, lifecycleIpcFeature);
      registerTeamRuntimeOperationsIpc(ipcMain, teamRuntimeOperationsFeature);
      registerTeamProvisioningIpc(ipcMain, teamProvisioningFeature);
      registerTeamConfigurationIpc(ipcMain, teamConfigurationFeature);
      registerTeamMessageDeliveryIpc(ipcMain, teamMessageDeliveryFeature);
      registerTeamRosterMutationIpc(ipcMain, teamRosterMutationFeature);
      registerTeamViewReadModelIpc(ipcMain, teamViewReadModelFeature);
      registerTeamTaskBoardIpc(ipcMain, teamTaskBoardFeature);
      registerTeamApprovalsIpc(ipcMain, {
        ...teamApprovalsFeature,
        logger: teamApprovalsLogger,
      });
      registerTaskLogObservabilityIpc(ipcMain, {
        readers: {
          activity: dependencies.boardTaskActivityService,
          activityDetail: dependencies.boardTaskActivityDetailService,
          stream: dependencies.boardTaskLogStreamService,
          exactLogSummaries: dependencies.boardTaskExactLogsService,
          exactLogDetail: dependencies.boardTaskExactLogDetailService,
        },
        logger: taskLogObservabilityLogger,
      });
    },
  };
}

export function removeDesktopTeamFeatureComposition(ipcMain: IpcMain): void {
  removeTeamHandlers(ipcMain);
  removeTeamLifecycleReadIpc(ipcMain);
  removeTeamLifecycleIpc(ipcMain);
  removeTeamRuntimeOperationsIpc(ipcMain);
  removeTeamProvisioningIpc(ipcMain);
  removeTeamConfigurationIpc(ipcMain);
  removeTeamMessageDeliveryIpc(ipcMain);
  removeTeamRosterMutationIpc(ipcMain);
  removeTeamViewReadModelIpc(ipcMain);
  removeTeamTaskBoardIpc(ipcMain);
  removeTeamApprovalsIpc(ipcMain);
  removeTaskLogObservabilityIpc(ipcMain);
}
