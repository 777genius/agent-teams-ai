import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { getAppIconPath } from '@main/utils/appIcon';
import { stripMarkdown } from '@main/utils/textFormatting';
import {
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_DELETE_TEAM,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_LIST,
  TEAM_PERMANENTLY_DELETE,
  TEAM_RESTORE,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createSafeAppError } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, Notification } from 'electron';
import * as path from 'path';

import { TeamPermanentDeletionTransactionCoordinator } from '../../features/team-view-read-model/main/adapters/output/TeamPermanentDeletionTransactionCoordinator';
import { ConfigManager } from '../services/infrastructure/ConfigManager';
import { NotificationManager } from '../services/infrastructure/NotificationManager';
import { gitIdentityResolver } from '../services/parsing/GitIdentityResolver';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '../services/team/LaunchIoGovernor';
import { TeamAttachmentStore } from '../services/team/TeamAttachmentStore';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';
import { TeamWorktreeGitService } from '../services/team/TeamWorktreeGitService';

import { validateTeamName } from './guards';

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
import type {
  IpcResult,
  TeamMessageNotificationData,
  TeamSummary,
  TeamWorktreeGitStatus,
} from '@shared/types';

const logger = createLogger('IPC:teams');

let teamDataService: TeamDataService | null = null;
let teamRuntimeApi: Pick<TeamRuntimeApi, 'stopTeam'> | null = null;
let teamBackupService: TeamBackupService | null = null;
let teammateToolTracker: TeammateToolTracker | null = null;
let teamLogSourceTracker: TeamLogSourceTracker | null = null;
let branchStatusService: BranchStatusService | null = null;
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
const worktreeGitService = new TeamWorktreeGitService();

/**
 * Prevents GC from collecting Notification objects in the deprecated showTeamNativeNotification.
 * @see https://blog.bloomca.me/2025/02/22/electron-mac-notifications.html
 */
const activeTeamNotifications = new Set<Notification>();
let teamLifecycleReadHost: TeamLifecycleReadHost | null = null;

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
  runtimeApi: Pick<TeamRuntimeApi, 'stopTeam'>,
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
  teamRuntimeApi = runtimeApi;
  teamBackupService = backupService ?? null;
  teammateToolTracker = toolTracker ?? null;
  teamLogSourceTracker = logSourceTracker ?? null;
  branchStatusService = branchTracker ?? null;
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
  ipcMain.handle(TEAM_SET_PROJECT_BRANCH_TRACKING, handleSetProjectBranchTracking);
  ipcMain.handle(TEAM_SET_TASK_LOG_STREAM_TRACKING, handleSetTaskLogStreamTracking);
  ipcMain.handle(TEAM_SET_TOOL_ACTIVITY_TRACKING, handleSetToolActivityTracking);
  ipcMain.handle(TEAM_GET_WORKTREE_GIT_STATUS, handleGetWorktreeGitStatus);
  ipcMain.handle(TEAM_INITIALIZE_GIT_REPOSITORY, handleInitializeGitRepository);
  ipcMain.handle(TEAM_CREATE_INITIAL_GIT_COMMIT, handleCreateInitialGitCommit);
  ipcMain.handle(TEAM_DELETE_TEAM, handleDeleteTeam);
  ipcMain.handle(TEAM_RESTORE, handleRestoreTeam);
  ipcMain.handle(TEAM_PERMANENTLY_DELETE, handlePermanentlyDeleteTeam);
  ipcMain.handle(TEAM_GET_PROJECT_BRANCH, handleGetProjectBranch);
  ipcMain.handle(TEAM_SHOW_MESSAGE_NOTIFICATION, handleShowMessageNotification);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  ipcMain.removeHandler(TEAM_SET_PROJECT_BRANCH_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TASK_LOG_STREAM_TRACKING);
  ipcMain.removeHandler(TEAM_SET_TOOL_ACTIVITY_TRACKING);
  ipcMain.removeHandler(TEAM_GET_WORKTREE_GIT_STATUS);
  ipcMain.removeHandler(TEAM_INITIALIZE_GIT_REPOSITORY);
  ipcMain.removeHandler(TEAM_CREATE_INITIAL_GIT_COMMIT);
  ipcMain.removeHandler(TEAM_DELETE_TEAM);
  ipcMain.removeHandler(TEAM_RESTORE);
  ipcMain.removeHandler(TEAM_PERMANENTLY_DELETE);
  ipcMain.removeHandler(TEAM_GET_PROJECT_BRANCH);
  ipcMain.removeHandler(TEAM_SHOW_MESSAGE_NOTIFICATION);
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

export async function waitForPendingPermanentDeletionRecoveryForTests(): Promise<void> {
  await permanentDeletionCoordinator?.waitForRecovery();
}

function getTeamRuntimeApi(): Pick<TeamRuntimeApi, 'stopTeam'> {
  if (!teamRuntimeApi) {
    throw new Error('Team runtime handlers are not initialized');
  }
  return teamRuntimeApi;
}

function getTeammateToolTracker(): TeammateToolTracker {
  if (!teammateToolTracker) {
    throw new Error('Teammate tool tracker is not initialized');
  }
  return teammateToolTracker;
}

function getTeamLogSourceTracker(): TeamLogSourceTracker {
  if (!teamLogSourceTracker) {
    throw new Error('Team log source tracker is not initialized');
  }
  return teamLogSourceTracker;
}

function getBranchStatusService(): BranchStatusService {
  if (!branchStatusService) {
    throw new Error('Branch status service is not initialized');
  }
  return branchStatusService;
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

async function handleGetProjectBranch(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<string | null>> {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { success: false, error: 'projectPath must be a non-empty string' };
  }
  try {
    const branch = await gitIdentityResolver.getBranch(path.normalize(projectPath.trim()));
    return { success: true, data: branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[teams:getProjectBranch] ${message}`);
    return { success: false, error: message };
  }
}

function validateProjectPathInput(
  projectPath: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { valid: false, error: 'projectPath must be a non-empty string' };
  }
  return { valid: true, value: path.normalize(projectPath.trim()) };
}

async function handleGetWorktreeGitStatus(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('getWorktreeGitStatus', () =>
    worktreeGitService.getStatus(validated.value)
  );
}

async function handleInitializeGitRepository(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('initializeGitRepository', () =>
    worktreeGitService.initializeRepository(validated.value)
  );
}

async function handleCreateInitialGitCommit(
  _event: IpcMainInvokeEvent,
  projectPath: unknown
): Promise<IpcResult<TeamWorktreeGitStatus>> {
  const validated = validateProjectPathInput(projectPath);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  return wrapTeamHandler('createInitialGitCommit', () =>
    worktreeGitService.createInitialCommit(validated.value)
  );
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

async function handleSetProjectBranchTracking(
  _event: IpcMainInvokeEvent,
  projectPath: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { success: false, error: 'projectPath must be a non-empty string' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setProjectBranchTracking', async () => {
    await getBranchStatusService().setTracking(projectPath.trim(), enabled);
  });
}

async function handleSetToolActivityTracking(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setToolActivityTracking', async () => {
    await getTeammateToolTracker().setTracking(validated.value!, enabled);
  });
}

async function handleSetTaskLogStreamTracking(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  enabled: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' };
  }

  return wrapTeamHandler('setTaskLogStreamTracking', async () => {
    if (enabled) {
      await getTeamLogSourceTracker().enableTracking(validated.value!, 'task_log_stream');
      return;
    }
    await getTeamLogSourceTracker().disableTracking(validated.value!, 'task_log_stream');
  });
}

async function handleDeleteTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('deleteTeam', async () => {
    await getTeamRuntimeApi().stopTeam(validated.value!);
    await getTeamDataService().deleteTeam(validated.value!);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
  });
}

async function handleRestoreTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('restoreTeam', async () => {
    await getTeamDataService().restoreTeam(validated.value!);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
  });
}

async function handlePermanentlyDeleteTeam(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<void>> {
  const validated = validateTeamName(teamName);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return wrapTeamHandler('permanentlyDeleteTeam', async () => {
    await getPermanentDeletionCoordinator().permanentlyDelete(validated.value!);
  });
}

async function handleShowMessageNotification(
  _event: IpcMainInvokeEvent,
  data: unknown
): Promise<IpcResult<void>> {
  if (!data || typeof data !== 'object') {
    return { success: false, error: 'Invalid notification data' };
  }
  const d = data as TeamMessageNotificationData;
  if (!d.teamDisplayName || !d.from || !d.body) {
    return { success: false, error: 'Missing required fields (teamDisplayName, from, body)' };
  }
  if (!d.teamName) {
    return {
      success: false,
      error: 'Missing required field: teamName (needed for deep-link navigation)',
    };
  }

  // Route through NotificationManager for unified storage + native toast.
  // dedupeKey is required from renderer — built from stable identifiers (taskId, teamName, etc.)
  const dedupeKey =
    d.dedupeKey ?? `msg:${d.teamName}:${d.from}:${d.summary ?? d.body.slice(0, 50)}`;

  void NotificationManager.getInstance()
    .addTeamNotification({
      teamEventType: d.teamEventType ?? 'task_clarification',
      teamName: d.teamName,
      teamDisplayName: d.teamDisplayName,
      from: d.from,
      to: d.to,
      summary: d.summary ?? `${d.from} → ${d.to ?? 'team'}`,
      body: d.body,
      dedupeKey,
      target: d.target,
      suppressToast: d.suppressToast,
    })
    .catch(() => undefined);

  return { success: true, data: undefined };
}

/**
 * Show a native OS notification for a team event.
 * @deprecated Use NotificationManager.addTeamNotification() instead for unified storage + toast.
 * Kept for backward compatibility with any remaining callers.
 */
export function showTeamNativeNotification(opts: {
  title: string;
  subtitle?: string;
  body: string;
}): void {
  const config = ConfigManager.getInstance().getConfig();
  if (!config.notifications.enabled) {
    logger.debug('[native-notification] skipped: notifications disabled');
    return;
  }
  if (config.notifications.snoozedUntil && Date.now() < config.notifications.snoozedUntil) {
    logger.debug('[native-notification] skipped: snoozed');
    return;
  }

  if (
    typeof Notification === 'undefined' ||
    typeof Notification.isSupported !== 'function' ||
    !Notification.isSupported()
  ) {
    logger.warn('[native-notification] skipped: Notification not supported on this platform');
    return;
  }

  const isMac = process.platform === 'darwin';
  const truncatedBody = stripMarkdown(opts.body).slice(0, 300);
  const iconPath = isMac ? undefined : getAppIconPath();
  const notification = new Notification({
    title: opts.title,
    ...(isMac && opts.subtitle ? { subtitle: opts.subtitle } : {}),
    body: !isMac && opts.subtitle ? `${opts.subtitle}\n${truncatedBody}` : truncatedBody,
    sound: config.notifications.soundEnabled ? 'default' : undefined,
    ...(iconPath ? { icon: iconPath } : {}),
  });

  // Hold a strong reference to prevent GC from collecting the notification.
  // macOS never fires 'close' for toasts the user ignores, so also drop the
  // reference after a grace window — otherwise ignored toasts accumulate for
  // the whole session. Late clicks from Notification Center past this window
  // are best-effort only.
  activeTeamNotifications.add(notification);
  const releaseTimer = setTimeout(cleanup, 15 * 60_000);
  releaseTimer.unref?.();
  function cleanup(): void {
    clearTimeout(releaseTimer);
    activeTeamNotifications.delete(notification);
  }

  notification.on('click', () => {
    const windows = BrowserWindow.getAllWindows();
    const mainWin = windows[0];
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
    cleanup();
  });
  notification.on('close', cleanup);

  notification.on('show', () => {
    logger.debug(`[native-notification] shown: "${opts.title}" — ${opts.subtitle ?? ''}`);
  });

  notification.on('failed', (_, error) => {
    logger.warn(`[native-notification] failed: ${error}`);
    cleanup();
  });

  notification.show();
}
