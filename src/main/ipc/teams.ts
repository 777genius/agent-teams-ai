import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import {
  TEAM_LIST,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createSafeAppError } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import { TeamPermanentDeletionTransactionCoordinator } from '../../features/team-view-read-model/main/adapters/output/TeamPermanentDeletionTransactionCoordinator';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '../services/team/LaunchIoGovernor';
import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';

import {
  initializeTeamAuxiliaryIpc,
  registerTeamAuxiliaryIpc,
  removeTeamAuxiliaryIpc,
} from './teamAuxiliaryIpc';

import type {
  BranchStatusService,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
} from '../services';
import type {
  TeamIpcHandlerApis,
  TeamRuntimeApi,
} from '../services/team/contracts/TeamProvisioningApis';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';
import type { IpcResult, TeamSummary } from '@shared/types';

const logger = createLogger('IPC:teams');

let teamDataService: TeamDataService | null = null;
let teamBackupService: TeamBackupService | null = null;
let launchIoGovernor: LaunchIoGovernor | null = null;
let teamPermanentDeletionLifecycle: {
  prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
} | null = null;
let permanentDeletionCoordinator: TeamPermanentDeletionTransactionCoordinator | null = null;

interface TeamIdentityLifecycle {
  resumeTeam(teamName: string): void;
}

function withTeamIdentityFence<T>(
  backupService: Pick<TeamBackupService, 'withTeamIdentityFence'> | undefined,
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  return backupService ? backupService.withTeamIdentityFence(teamName, operation) : operation();
}

export function createIdentityFencedProvisioningStart(
  provisioningStart: TeamIpcHandlerApis['provisioningStart'],
  backupService: Pick<TeamBackupService, 'withTeamIdentityFence'> | undefined,
  lifecycle: TeamIdentityLifecycle | undefined
): TeamIpcHandlerApis['provisioningStart'] {
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
  lifecycle: TeamIdentityLifecycle | undefined,
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

const attachmentStore = new TeamAttachmentStore();
const taskAttachmentStore = new TeamTaskAttachmentStore();
let teamLifecycleReadHost: TeamLifecycleReadHost | null = null;

export { showTeamNativeNotification } from './teamAuxiliaryIpc';

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

export function initializeTeamHandlers(
  service: TeamDataService,
  _runtimeApi: Pick<TeamRuntimeApi, 'stopTeam'>,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  logSourceTracker?: TeamLogSourceTracker,
  branchTracker?: BranchStatusService,
  ioGovernor?: LaunchIoGovernor,
  permanentDeletionLifecycle?: {
    prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
    completeTeamDeletion(teamName: string): void;
    resumeTeam(teamName: string): void;
  }
): void {
  teamDataService = service;
  teamBackupService = backupService ?? null;
  initializeTeamAuxiliaryIpc({
    toolTracker,
    logSourceTracker,
    branchTracker,
  });
  launchIoGovernor = ioGovernor ?? null;
  teamPermanentDeletionLifecycle = permanentDeletionLifecycle ?? null;
  permanentDeletionCoordinator = new TeamPermanentDeletionTransactionCoordinator({
    backupService: () => teamBackupService,
    dataService: () => getTeamDataService(),
    attachmentStore,
    taskAttachmentStore,
    lifecycle: () => teamPermanentDeletionLifecycle,
    invalidateTeamConfig: (teamName) => getTeamDataWorkerClient().invalidateTeamConfig(teamName),
    logRecoveryError: (teamName, error) =>
      logger.error(
        `[PermanentDeletion] ${teamName === 'startup' ? 'Startup recovery failed' : `Recovery remains pending for ${teamName}`}: ${String(error)}`
      ),
  });
  permanentDeletionCoordinator.startRecovery();
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TEAM_LIST, handleListTeams);
  registerTeamAuxiliaryIpc(ipcMain);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  removeTeamAuxiliaryIpc(ipcMain);
}

function getTeamDataService(): TeamDataService {
  if (!teamDataService) {
    throw new Error('Team handlers are not initialized');
  }
  return teamDataService;
}

function getPermanentDeletionCoordinator(): TeamPermanentDeletionTransactionCoordinator {
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

async function wrapTeamHandler<T>(
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

async function handleListTeams(
  _event: IpcMainInvokeEvent,
  teamLifecycleReadRequest?: unknown
): Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>> {
  if (teamLifecycleReadRequest !== undefined) {
    return wrapTeamHandler('listTeamLifecycle', () =>
      handleListTeamLifecycle(teamLifecycleReadRequest)
    );
  }
  setCurrentMainOp('team:list');
  const startedAt = Date.now();
  try {
    return await wrapTeamHandler('list', () => {
      const loadFresh = () => getTeamDataService().listTeams();
      return launchIoGovernor
        ? launchIoGovernor.runSummaryOperation('teams:list', loadFresh, {
            clone: cloneLaunchIoGovernorPayload,
          })
        : loadFresh();
    });
  } finally {
    const ms = Date.now() - startedAt;
    if (ms >= 1500) {
      logger.warn(`[teams:list] slow ms=${ms}`);
    }
    setCurrentMainOp(null);
  }
}
