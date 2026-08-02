import {
  createTeamApprovalsFeature as createApprovalsFeature,
  type TeamApprovalsIpcDependencies,
} from '@features/team-approvals/main';
import {
  createTeamConfigurationFeature as createConfigurationFeature,
  type TeamConfigurationFeature,
} from '@features/team-configuration/main';
import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import {
  createTeamLifecycleIpcFeature,
  createTeamLifecycleReadIpcFeature,
  type TeamLifecycleAtomicCommandPort,
  type TeamLifecycleIpcFeature,
  type TeamLifecycleReadIpcFeature,
} from '@features/team-lifecycle/main';
import { TEAM_PROCESS_ALIVE, TEAM_PROCESS_SEND } from '@features/team-message-delivery/contracts';
import {
  createDesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryFeature,
} from '@features/team-message-delivery/main';
import { type TeamProvisioningFeature } from '@features/team-provisioning/main';
import {
  createTeamRosterMutationFeature as createRosterMutationFeature,
  type TeamRosterMutationFeature,
} from '@features/team-roster-mutations/main';
import {
  createTeamRuntimeOperationsFeature as createRuntimeOperationsFeature,
  type TeamRuntimeOperationsFeature,
} from '@features/team-runtime-operations/main';
import {
  createTeamTaskBoardFeature as createTaskBoardFeature,
  type TeamTaskBoardFeature,
} from '@features/team-task-board/main';
import {
  createTeamViewReadModelFeature as createViewReadModelFeature,
  type TeamViewReadModelFeature,
} from '@features/team-view-read-model/main';
import { buildActionModeAgentBlock } from '@main/services/team/actionModeInstructions';
import { NodeToolApprovalFileReader } from '@main/services/team/approvals/NodeToolApprovalFileReader';
import { FileSystemDraftTeamConfigGuard } from '@main/services/team/configuration/FileSystemDraftTeamConfigGuard';
import { buildOpenCodeRuntimeDeliveryUserVisibleImpact } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { createSafeAppError } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';

import { setCurrentMainOp } from '../services/infrastructure/EventLoopLagMonitor';
import { cloneLaunchIoGovernorPayload } from '../services/team/LaunchIoGovernor';

import { validateTeamName } from './guards';
import { createDesktopTeamProvisioningFeature as createProvisioningFeature } from './teamProvisioningHost';
import {
  createDesktopMissingTeamStateSources,
  createDesktopTeamViewReadModelEnvironment,
} from './teamViewReadModelHost';

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
import type { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';
import type {
  DesktopTeamFeatureCapabilities,
  DesktopTeamProvisioningStartCapability,
  DesktopTeamRuntimeCapability,
} from './teamFeatureCapabilities';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';
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

export interface TeamPermanentDeletionLifecycle {
  prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
}

export interface DesktopTeamLegacyAdapterDependencies {
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

export interface DesktopTeamLegacyAdapterFacade {
  createIdentityFencedProvisioningStart: typeof createIdentityFencedProvisioningStart;
  createIdentityFencedTeamConfigurationRepository: typeof createIdentityFencedTeamConfigurationRepository;
  handleListTeamLifecycle: typeof handleListTeamLifecycle;
  permanentlyDeleteDraftTeam: typeof permanentlyDeleteDraftTeam;
  permanentlyDeleteTeam: typeof permanentlyDeleteTeam;
}

export interface DesktopTeamLegacyAdapters {
  lifecycleRead: TeamLifecycleReadIpcFeature;
  lifecycle: TeamLifecycleIpcFeature;
  runtimeOperations: TeamRuntimeOperationsFeature;
  provisioning: TeamProvisioningFeature;
  configuration: TeamConfigurationFeature;
  messageDelivery: DesktopTeamMessageDeliveryFeature;
  legacyProcess: DesktopTeamLegacyProcessAdapters;
  rosterMutation: TeamRosterMutationFeature;
  viewReadModel: TeamViewReadModelFeature;
  taskBoard: TeamTaskBoardFeature;
  approvals: TeamApprovalsIpcDependencies;
  taskLogObservability: {
    readers: {
      activity: BoardTaskActivityService;
      activityDetail: BoardTaskActivityDetailService;
      stream: BoardTaskLogStreamService;
      exactLogSummaries: BoardTaskExactLogsService;
      exactLogDetail: BoardTaskExactLogDetailService;
    };
    logger: ReturnType<typeof createLogger>;
  };
}

export interface DesktopTeamLegacyProcessAdapters {
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
  isTeamAlive(teamName: string): boolean;
  logger: Pick<ReturnType<typeof createLogger>, 'error'>;
}

interface TeamPermanentDeletionCoordinatorPorts {
  backupService(): TeamBackupService | null;
  dataService(): Pick<TeamDataService, 'permanentlyDeleteTeam'>;
  attachmentStore: TeamAttachmentStore;
  taskAttachmentStore: TeamTaskAttachmentStore;
  lifecycle(): TeamPermanentDeletionLifecycle | null;
  invalidateTeamConfig(teamName: string): void;
  logRecoveryError(teamName: string, error: unknown): void;
}

interface TeamPermanentDeletionCoordinator {
  startRecovery(): void;
  waitForRecovery(): Promise<void>;
  permanentlyDelete(teamName: string): Promise<void>;
  permanentlyDeleteDraft(teamName: string): Promise<void>;
}

type TeamPermanentDeletionCoordinatorConstructor = new (
  ports: TeamPermanentDeletionCoordinatorPorts
) => TeamPermanentDeletionCoordinator;

let teamDataService: TeamDataService | null = null;
let teamBackupService: TeamBackupService | null = null;
let teamPermanentDeletionLifecycle: TeamPermanentDeletionLifecycle | null = null;
let permanentDeletionCoordinator: TeamPermanentDeletionCoordinator | null = null;
let teamLifecycleReadHost: TeamLifecycleReadHost | null = null;
let permanentDeletionStores: {
  attachmentStore: TeamAttachmentStore;
  taskAttachmentStore: TeamTaskAttachmentStore;
} | null = null;

function withTeamIdentityFence<T>(
  backupService: Pick<TeamBackupService, 'withTeamIdentityFence'> | undefined,
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  return backupService ? backupService.withTeamIdentityFence(teamName, operation) : operation();
}

export function createIdentityFencedProvisioningStart(
  provisioningStart: DesktopTeamProvisioningStartCapability,
  backupService: Pick<TeamBackupService, 'withTeamIdentityFence'> | undefined,
  lifecycle: Pick<TeamPermanentDeletionLifecycle, 'resumeTeam'> | undefined
): DesktopTeamProvisioningStartCapability {
  return {
    createTeam: (request, onProgress) =>
      withTeamIdentityFence(backupService, request.teamName, async () => {
        const response = await provisioningStart.createTeam(request, onProgress);
        lifecycle?.resumeTeam(request.teamName);
        return response;
      }),
    launchTeam: async (request, onProgress) => {
      const response = await provisioningStart.launchTeam(request, onProgress);
      lifecycle?.resumeTeam(request.teamName);
      return response;
    },
  };
}

export function createIdentityFencedTeamConfigurationRepository(
  repository: TeamDataService,
  backupService: Pick<TeamBackupService, 'withTeamIdentityFence'> | undefined,
  lifecycle: Pick<TeamPermanentDeletionLifecycle, 'resumeTeam'> | undefined,
  deleteDraft: (teamName: string) => Promise<void>
) {
  return {
    createTeamConfig: (request: Parameters<TeamDataService['createTeamConfig']>[0]) =>
      withTeamIdentityFence(backupService, request.teamName, async () => {
        await repository.createTeamConfig(request);
        lifecycle?.resumeTeam(request.teamName);
      }),
    getTeamDisplayName: (teamName: string) => repository.getTeamDisplayName(teamName),
    updateConfig: (teamName: string, updates: Parameters<TeamDataService['updateConfig']>[1]) =>
      repository.updateConfig(teamName, updates),
    getSavedRequest: (teamName: string) => repository.getSavedRequest(teamName),
    permanentlyDeleteTeam: deleteDraft,
  };
}

export function initializeTeamLifecycleReadHandler(host: TeamLifecycleReadHost): void {
  teamLifecycleReadHost = host;
}

function teamLifecycleReadUnavailable(reason: string): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code: 'unavailable', reason });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: true,
  });
}

export async function handleListTeamLifecycle(
  request: unknown
): Promise<CanonicalListTeamLifecycleResult> {
  if (!teamLifecycleReadHost) {
    return teamLifecycleReadUnavailable('identity_storage_unavailable');
  }
  try {
    return await teamLifecycleReadHost.listTeamLifecycle(request);
  } catch {
    return teamLifecycleReadUnavailable('transport_unavailable');
  }
}

export function initializeLegacyTeamHandlers(
  initializeAuxiliary: (options: {
    toolTracker?: TeammateToolTracker;
    logSourceTracker?: TeamLogSourceTracker;
    branchTracker?: BranchStatusService;
  }) => void,
  PermanentDeletionCoordinator: TeamPermanentDeletionCoordinatorConstructor,
  createPermanentDeletionStores: () => {
    attachmentStore: TeamAttachmentStore;
    taskAttachmentStore: TeamTaskAttachmentStore;
  },
  service: TeamDataService,
  _runtimeApi: Pick<DesktopTeamRuntimeCapability, 'stopTeam'>,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  logSourceTracker?: TeamLogSourceTracker,
  branchTracker?: BranchStatusService,
  _ioGovernor?: LaunchIoGovernor,
  permanentDeletionLifecycle?: TeamPermanentDeletionLifecycle
): void {
  teamDataService = service;
  teamBackupService = backupService ?? null;
  initializeAuxiliary({
    toolTracker,
    logSourceTracker,
    branchTracker,
  });
  teamPermanentDeletionLifecycle = permanentDeletionLifecycle ?? null;
  permanentDeletionStores ??= createPermanentDeletionStores();
  permanentDeletionCoordinator = new PermanentDeletionCoordinator({
    backupService: () => teamBackupService,
    dataService: () => getTeamDataService(),
    attachmentStore: permanentDeletionStores.attachmentStore,
    taskAttachmentStore: permanentDeletionStores.taskAttachmentStore,
    lifecycle: () => teamPermanentDeletionLifecycle,
    invalidateTeamConfig: (teamName) => getTeamDataWorkerClient().invalidateTeamConfig(teamName),
    logRecoveryError: (teamName, error) =>
      teamLifecycleIpcLogger.error(
        `[PermanentDeletion] ${teamName === 'startup' ? 'Startup recovery failed' : `Recovery remains pending for ${teamName}`}: ${String(error)}`
      ),
  });
  permanentDeletionCoordinator.startRecovery();
}

export function registerLegacyTeamHandlers(
  ipcMain: IpcMain,
  registerAuxiliary: (ipcMain: IpcMain) => void
): void {
  registerAuxiliary(ipcMain);
  teamLifecycleIpcLogger.info('Team handlers registered');
}

export function removeLegacyTeamHandlers(
  ipcMain: IpcMain,
  removeAuxiliary: (ipcMain: IpcMain) => void
): void {
  removeAuxiliary(ipcMain);
}

export function registerLegacyTeamProcessIpc(
  ipcMain: IpcMain,
  adapters: DesktopTeamLegacyProcessAdapters
): void {
  ipcMain.handle(TEAM_PROCESS_SEND, async (_event, teamName: unknown, message: unknown) => {
    const validatedTeamName = validateRequiredLegacyTeamName(teamName);
    if (!validatedTeamName.valid) return { success: false, error: validatedTeamName.error };
    if (typeof message !== 'string' || message.trim().length === 0) {
      return { success: false, error: 'message must be a non-empty string' };
    }
    return executeLegacyProcessOperation(adapters, 'processSend', async () => {
      await adapters.sendMessageToTeam(validatedTeamName.value, message);
    });
  });
  ipcMain.handle(TEAM_PROCESS_ALIVE, async (_event, teamName: unknown) => {
    const validatedTeamName = validateRequiredLegacyTeamName(teamName);
    if (!validatedTeamName.valid) return { success: false, error: validatedTeamName.error };
    return executeLegacyProcessOperation(adapters, 'processAlive', async () =>
      adapters.isTeamAlive(validatedTeamName.value)
    );
  });
}

export function removeLegacyTeamProcessIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_PROCESS_SEND);
  ipcMain.removeHandler(TEAM_PROCESS_ALIVE);
}

async function executeLegacyProcessOperation<T>(
  adapters: DesktopTeamLegacyProcessAdapters,
  operation: string,
  execute: () => Promise<T>
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    return { success: true, data: await execute() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    adapters.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

function validateRequiredLegacyTeamName(
  teamName: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  const validated = validateTeamName(teamName);
  if (!validated.valid || typeof validated.value !== 'string') {
    return { valid: false, error: validated.error ?? 'Invalid teamName' };
  }
  return { valid: true, value: validated.value };
}

function getTeamDataService(): TeamDataService {
  if (!teamDataService) {
    throw new Error('Team handlers are not initialized');
  }
  return teamDataService;
}

function getPermanentDeletionCoordinator(): TeamPermanentDeletionCoordinator {
  if (!permanentDeletionCoordinator) {
    throw new Error('Permanent deletion is unavailable until team handlers are initialized');
  }
  return permanentDeletionCoordinator;
}

export function permanentlyDeleteDraftTeam(teamName: string): Promise<void> {
  return getPermanentDeletionCoordinator().permanentlyDeleteDraft(teamName);
}

export function permanentlyDeleteTeam(teamName: string): Promise<void> {
  return getPermanentDeletionCoordinator().permanentlyDelete(teamName);
}

export async function waitForPendingPermanentDeletionRecoveryForTests(): Promise<void> {
  await permanentDeletionCoordinator?.waitForRecovery();
}

function createLegacyTeamLifecycleCommandAcl(
  dependencies: DesktopTeamLegacyAdapterDependencies,
  facade: DesktopTeamLegacyAdapterFacade
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
    permanentlyDeleteTeam: facade.permanentlyDeleteTeam,
  });
}

const defaultFacade: DesktopTeamLegacyAdapterFacade = Object.freeze({
  createIdentityFencedProvisioningStart,
  createIdentityFencedTeamConfigurationRepository,
  handleListTeamLifecycle,
  permanentlyDeleteDraftTeam,
  permanentlyDeleteTeam,
});

export function createDesktopTeamLegacyAdapters(
  dependencies: DesktopTeamLegacyAdapterDependencies,
  facade: DesktopTeamLegacyAdapterFacade = defaultFacade
): DesktopTeamLegacyAdapters {
  const lifecycleRead = createTeamLifecycleReadIpcFeature({
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
      listTeamLifecycle: (request) => facade.handleListTeamLifecycle(request),
    },
    operations: {
      setCurrent: setCurrentMainOp,
    },
    clock: {
      now: Date.now,
    },
    logger: teamLifecycleIpcLogger,
  });
  const lifecycle = createTeamLifecycleIpcFeature({
    commands: createLegacyTeamLifecycleCommandAcl(dependencies, facade),
    logger: teamLifecycleIpcLogger,
    validateTeamName,
  });
  const lifecycleAwareProvisioningStart = facade.createIdentityFencedProvisioningStart(
    dependencies.capabilities.provisioningStart,
    dependencies.teamBackupService,
    dependencies.teamPermanentDeletionLifecycle
  );
  const approvalsFeature = createApprovalsFeature({
    fileReader: new NodeToolApprovalFileReader(),
    toolApprovalApi: dependencies.capabilities.toolApproval,
  });
  const taskBoard = createTaskBoardFeature({
    taskBoardApi: dependencies.teamDataService,
    runtimeApi: dependencies.capabilities.runtime,
    notificationApi: dependencies.capabilities.messaging,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamTaskBoardLogger,
  });
  const viewReadModel = createViewReadModelFeature({
    data: dependencies.teamDataService,
    provisioningRuns: dependencies.capabilities.provisioningRun,
    taskActivity: dependencies.capabilities.taskActivity,
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.liveLeadMessages,
    logger: teamViewReadModelLogger,
    environment: createDesktopTeamViewReadModelEnvironment(),
    missingTeamStateSources: createDesktopMissingTeamStateSources(),
  });
  const configuration = createConfigurationFeature({
    draftGuard: new FileSystemDraftTeamConfigGuard(),
    repository: facade.createIdentityFencedTeamConfigurationRepository(
      dependencies.teamDataService,
      dependencies.teamBackupService,
      dependencies.teamPermanentDeletionLifecycle,
      facade.permanentlyDeleteDraftTeam
    ),
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.messaging,
    logger: teamConfigurationLogger,
  });
  const attachmentStore = new TeamAttachmentStore();
  const memberRoster = new TeamMembersMetaStore();
  const messageDelivery = createDesktopTeamMessageDeliveryFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.capabilities.runtime,
    messaging: dependencies.capabilities.messageDeliveryCompatibility,
    logger: teamMessageDeliveryLogger,
    attachments: {
      saveAttachments: (teamName, messageId, attachments) =>
        attachmentStore.saveAttachments(teamName, messageId, attachments),
      getAttachments: (teamName, messageId) => attachmentStore.getAttachments(teamName, messageId),
    },
    roster: {
      getMembers: (teamName) => memberRoster.getMembers(teamName),
    },
    actionModeInstructions: {
      buildAgentBlock: (mode) => buildActionModeAgentBlock(mode),
    },
    runtimeDeliveryImpact: {
      buildImpact: (delivery) => buildOpenCodeRuntimeDeliveryUserVisibleImpact(delivery),
    },
  });
  const rosterMutation = createRosterMutationFeature({
    repository: dependencies.teamDataService,
    runtime: dependencies.capabilities.runtime,
    lifecycle: dependencies.capabilities.rosterLifecycle,
    messaging: dependencies.capabilities.messaging,
    logger: teamRosterMutationLogger,
  });
  const provisioning = createProvisioningFeature({
    start: lifecycleAwareProvisioningStart,
    status: dependencies.capabilities.provisioningStatus,
    preflight: dependencies.capabilities.preflight,
    provisioningRun: dependencies.capabilities.provisioningRun,
    repository: dependencies.teamDataService,
    launchIoGovernor: dependencies.launchIoGovernor,
    logger: teamProvisioningLogger,
  });
  const runtime = dependencies.capabilities.runtime;
  const runtimeLifecycle = dependencies.capabilities.runtimeLifecycle;
  const diagnostics = dependencies.capabilities.runtimeDiagnostics;
  const runtimeLogs = dependencies.capabilities.runtimeLogs;
  const messaging = dependencies.capabilities.messaging;
  const data = dependencies.teamDataService;
  const memberLogs = dependencies.teamMemberLogsFinder;
  const memberStats = dependencies.memberStatsComputer;
  const runtimeOperations = createRuntimeOperationsFeature({
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
    lifecycle: runtimeLifecycle,
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
    lifecycleRead,
    lifecycle,
    runtimeOperations,
    provisioning,
    configuration,
    messageDelivery,
    legacyProcess: {
      sendMessageToTeam: (teamName, message) => messaging.sendMessageToTeam(teamName, message),
      isTeamAlive: (teamName) => runtime.isTeamAlive(teamName),
      logger: teamMessageDeliveryLogger,
    },
    rosterMutation,
    viewReadModel,
    taskBoard,
    approvals: {
      ...approvalsFeature,
      logger: teamApprovalsLogger,
    },
    taskLogObservability: {
      readers: {
        activity: dependencies.boardTaskActivityService,
        activityDetail: dependencies.boardTaskActivityDetailService,
        stream: dependencies.boardTaskLogStreamService,
        exactLogSummaries: dependencies.boardTaskExactLogsService,
        exactLogDetail: dependencies.boardTaskExactLogDetailService,
      },
      logger: taskLogObservabilityLogger,
    },
  };
}
