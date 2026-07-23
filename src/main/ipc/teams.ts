import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
} from '@features/team-lifecycle/contracts';
import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import { getAppIconPath } from '@main/utils/appIcon';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { stripMarkdown } from '@main/utils/textFormatting';
import {
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_LIST,
  TEAM_PERMANENTLY_DELETE,
  TEAM_RESTORE,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createSafeAppError } from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigManager } from '../services/infrastructure/ConfigManager';
import { NotificationManager } from '../services/infrastructure/NotificationManager';
import { gitIdentityResolver } from '../services/parsing/GitIdentityResolver';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '../services/team/LaunchIoGovernor';
import { TeamTaskAttachmentStore } from '../services/team/TeamTaskAttachmentStore';
import { TeamWorktreeGitService } from '../services/team/TeamWorktreeGitService';

import { validateTaskId, validateTeamName } from './guards';

import type {
  BranchStatusService,
  TeamDataService,
  TeamLogSourceTracker,
  TeammateToolTracker,
} from '../services';
import type { TeamRuntimeApi } from '../services/team/contracts/TeamProvisioningApis';
import type { TeamBackupService } from '../services/team/TeamBackupService';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';
import type {
  IpcResult,
  TaskAttachmentMeta,
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
  prepareTeamDeletion(teamName: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
} | null = null;

const taskAttachmentStore = new TeamTaskAttachmentStore();
const worktreeGitService = new TeamWorktreeGitService();

function isValidStoredAttachmentMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (v.length > 200) return false;
  if (v.includes('\0') || /[\r\n]/.test(v)) return false;
  const slash = v.indexOf('/');
  return slash > 0 && slash < v.length - 1;
}

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
    prepareTeamDeletion(teamName: string): Promise<void>;
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
  ipcMain.handle(TEAM_SAVE_TASK_ATTACHMENT, handleSaveTaskAttachment);
  ipcMain.handle(TEAM_GET_TASK_ATTACHMENT, handleGetTaskAttachment);
  ipcMain.handle(TEAM_DELETE_TASK_ATTACHMENT, handleDeleteTaskAttachment);
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
  ipcMain.removeHandler(TEAM_SAVE_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_GET_TASK_ATTACHMENT);
  ipcMain.removeHandler(TEAM_DELETE_TASK_ATTACHMENT);
}

function getTeamDataService(): TeamDataService {
  if (!teamDataService) {
    throw new Error('Team handlers are not initialized');
  }
  return teamDataService;
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
    const teamName = validated.value!;
    await teamPermanentDeletionLifecycle?.prepareTeamDeletion(teamName);
    await getTeamDataService().permanentlyDeleteTeam(teamName);
    teamPermanentDeletionLifecycle?.completeTeamDeletion(teamName);
    getTeamDataWorkerClient().invalidateTeamConfig(validated.value!);
    // Clean up app-owned data (attachments, task-attachments) that lives outside ~/.claude/
    const appData = getAppDataPath();
    await fs.promises
      .rm(path.join(appData, 'attachments', validated.value!), { recursive: true, force: true })
      .catch(() => undefined);
    await fs.promises
      .rm(path.join(appData, 'task-attachments', validated.value!), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
    // Mark in backup registry AFTER successful deletion
    if (teamBackupService) {
      await teamBackupService.markDeletedByUser(validated.value!);
    }
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

// ---------------------------------------------------------------------------
// Task Attachment Handlers
// ---------------------------------------------------------------------------

async function handleSaveTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  filename: unknown,
  mimeType: unknown,
  base64Data: unknown
): Promise<IpcResult<TaskAttachmentMeta>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    return { success: false, error: 'filename must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  if (typeof base64Data !== 'string' || base64Data.length === 0) {
    return { success: false, error: 'base64Data must be a non-empty string' };
  }
  // Sanitize IDs against path traversal
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('saveTaskAttachment', async () => {
    const meta = await taskAttachmentStore.saveAttachment(
      vTeam.value!,
      vTask.value!,
      safeAttId,
      filename,
      mimeType.trim(),
      base64Data
    );
    // Write metadata into the task JSON
    await getTeamDataService().addTaskAttachment(vTeam.value!, vTask.value!, meta);
    return meta;
  });
}

async function handleGetTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  mimeType: unknown
): Promise<IpcResult<string | null>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('getTaskAttachment', () =>
    taskAttachmentStore.getAttachment(vTeam.value!, vTask.value!, safeAttId, mimeType.trim())
  );
}

async function handleDeleteTaskAttachment(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
  attachmentId: unknown,
  mimeType: unknown
): Promise<IpcResult<void>> {
  const vTeam = validateTeamName(teamName);
  if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
  const vTask = validateTaskId(taskId);
  if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
    return { success: false, error: 'attachmentId must be a non-empty string' };
  }
  if (!isValidStoredAttachmentMimeType(mimeType)) {
    return { success: false, error: 'Invalid mimeType' };
  }
  const safeAttId = attachmentId.trim();
  if (safeAttId.includes('/') || safeAttId.includes('\\') || safeAttId.includes('..')) {
    return { success: false, error: 'Invalid attachmentId' };
  }

  return wrapTeamHandler('deleteTaskAttachment', async () => {
    await taskAttachmentStore.deleteAttachment(
      vTeam.value!,
      vTask.value!,
      safeAttId,
      mimeType.trim()
    );
    // Remove metadata from task JSON
    await getTeamDataService().removeTaskAttachment(vTeam.value!, vTask.value!, safeAttId);
  });
}
