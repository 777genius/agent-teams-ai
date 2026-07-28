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

import {
  createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository,
  initializeTeamHandlers,
  permanentlyDeleteDraftTeam,
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
import type { TeamIpcHandlerApis } from '../services/team/contracts/TeamProvisioningApis';
import type { LaunchIoGovernor } from '../services/team/LaunchIoGovernor';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { IpcMain } from 'electron';

const taskLogObservabilityLogger = createLogger('IPC:teams');
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
  teamHandlerApis: TeamIpcHandlerApis;
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

export function createDesktopTeamFeatureComposition(
  dependencies: DesktopTeamFeatureCompositionDependencies
): DesktopTeamFeatureComposition {
  const lifecycleAwareProvisioningStart = createIdentityFencedProvisioningStart(
    dependencies.teamHandlerApis.provisioningStart,
    dependencies.teamBackupService,
    dependencies.teamPermanentDeletionLifecycle
  );
  const teamApprovalsFeature = createTeamApprovalsFeature({
    toolApprovalApi: dependencies.teamHandlerApis.toolApproval,
  });
  const teamTaskBoardFeature = createTeamTaskBoardFeature({
    taskBoardApi: dependencies.teamDataService,
    runtimeApi: dependencies.teamHandlerApis.runtime,
    notificationApi: dependencies.teamHandlerApis.messaging,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamTaskBoardLogger,
  });
  const teamViewReadModelFeature = createTeamViewReadModelFeature({
    data: dependencies.teamDataService,
    provisioningRuns: dependencies.teamHandlerApis.provisioningRun,
    taskActivity: dependencies.teamHandlerApis.taskActivity,
    runtime: dependencies.teamHandlerApis.runtime,
    messaging: dependencies.teamHandlerApis.messaging,
    logger: teamViewReadModelLogger,
  });
  const teamConfigurationFeature = createTeamConfigurationFeature({
    repository: createIdentityFencedTeamConfigurationRepository(
      dependencies.teamDataService,
      dependencies.teamBackupService,
      dependencies.teamPermanentDeletionLifecycle,
      permanentlyDeleteDraftTeam
    ),
    runtime: dependencies.teamHandlerApis.runtime,
    messaging: dependencies.teamHandlerApis.messaging,
    logger: teamConfigurationLogger,
  });
  const teamMessageDeliveryFeature = createTeamMessageDeliveryFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.teamHandlerApis.runtime,
    messaging: dependencies.teamHandlerApis.messaging,
    logger: teamMessageDeliveryLogger,
  });
  const teamRosterMutationFeature = createTeamRosterMutationFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.teamHandlerApis.runtime,
    lifecycle: dependencies.teamHandlerApis.memberLifecycle,
    messaging: dependencies.teamHandlerApis.messaging,
    logger: teamRosterMutationLogger,
  });
  const teamProvisioningFeature = createTeamProvisioningFeature({
    start: lifecycleAwareProvisioningStart,
    status: dependencies.teamHandlerApis.provisioningStatus,
    preflight: dependencies.teamHandlerApis.preflight,
    provisioningRun: dependencies.teamHandlerApis.provisioningRun,
    repository: dependencies.teamDataService,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamProvisioningLogger,
  });
  const teamRuntimeOperationsFeature = createTeamRuntimeOperationsFeature({
    data: dependencies.teamDataService,
    runtime: dependencies.teamHandlerApis.runtime,
    lifecycle: dependencies.teamHandlerApis.memberLifecycle,
    diagnostics: dependencies.teamHandlerApis.diagnostics,
    claudeLogs: dependencies.teamHandlerApis.claudeLogs,
    messaging: dependencies.teamHandlerApis.messaging,
    logsFinder: dependencies.teamMemberLogsFinder,
    statsComputer: dependencies.memberStatsComputer,
    logger: teamRuntimeOperationsLogger,
  });

  return {
    initializeLegacyHandlers(): void {
      initializeTeamHandlers(
        dependencies.teamDataService,
        dependencies.teamHandlerApis.runtime,
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
