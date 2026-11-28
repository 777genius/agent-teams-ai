/** Existing Electron review transport; policy and mutable review state live in the captured writer. */
import { createReviewWriter } from '@agent-teams/task-change-ledger/review-writer';
import { createIpcWrapper } from '@main/ipc/ipcWrapper';
import { EditorFileWatcher } from '@main/services/editor';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { readProcessStartTimeMs } from '@main/utils/processStartTime';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import {
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_CLEAR_DECISIONS,
  REVIEW_CLEAR_DRAFT_HISTORY,
  REVIEW_DELETE_EDITED_FILE,
  REVIEW_EXECUTE_MUTATION,
  REVIEW_FILE_CHANGE,
  REVIEW_GET_AGENT_CHANGES,
  REVIEW_GET_CHANGE_STATS,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_GET_GIT_FILE_LOG,
  REVIEW_GET_TASK_CHANGES,
  REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES,
  REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES,
  REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
  REVIEW_PREVIEW_REJECT,
  REVIEW_REAPPLY_REJECTED_RENAME,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
  REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_RESTORE_HISTORY,
  REVIEW_RESTORE_REJECTED_RENAME,
  REVIEW_RETRY_MUTATION_RECOVERY,
  REVIEW_SAVE_DECISIONS,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
  REVIEW_SAVE_EDITED_FILE,
  REVIEW_UNWATCH_FILES,
  REVIEW_WATCH_FILES,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { ReviewWriter } from '@agent-teams/task-change-ledger/review-writer';
import type { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import type { FileContentResolver } from '@main/services/team/FileContentResolver';
import type { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import type { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import type { IpcResult } from '@shared/types/ipc';
import type {
  AgentChangeSet,
  ChangeStats,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '@shared/types/review';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const wrapReviewHandler = createIpcWrapper('IPC:review');
const logger = createLogger('IPC:review');
const TEAM_TASK_CHANGE_SUMMARY_IPC_RAW_REQUEST_LIMIT = 1_000;
const TEAM_TASK_CHANGE_SUMMARY_IPC_UNIQUE_REQUEST_LIMIT = 201;
let changeExtractor: ChangeExtractorService | null = null;
let gitDiffFallback: GitDiffFallback | null = null;
let writer: ReviewWriter | null = null;
let ownerGeneration = 0;
export type ReviewFileWatcher = Pick<
  EditorFileWatcher,
  'isWatching' | 'setWatchedFiles' | 'start' | 'stop'
>;
const defaultReviewFileWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
let reviewFileWatcher: ReviewFileWatcher = defaultReviewFileWatcher;
let reviewWatcherProjectRoot: string | null = null;
let reviewWatcherRequestGeneration = 0;
let reviewWatcherEpoch = 0;
let reviewMainWindowRef: BrowserWindow | null = null;
let reviewProjectPathValidator: (projectPath: string) => Promise<string> =
  validateReviewProjectPath;

export interface ReviewHandlerDeps {
  extractor: ChangeExtractorService;
  applier?: ReviewApplierService;
  contentResolver?: FileContentResolver;
  gitFallback?: GitDiffFallback;
  configReader?: Pick<TeamConfigReader, 'getConfig'>;
  fileWatcher?: ReviewFileWatcher;
  projectPathValidator?: (projectPath: string) => Promise<string>;
}

export function initializeReviewHandlers(deps: ReviewHandlerDeps): void {
  writer?.dispose();
  const generation = ++ownerGeneration;
  const teamsRoot = getTeamsBasePath();
  const configReader = deps.configReader ?? new TeamConfigReader();
  const contentResolver = deps.contentResolver;
  changeExtractor = deps.extractor;
  gitDiffFallback = deps.gitFallback ?? null;
  writer = createReviewWriter({
    teamsRoot,
    changes: deps.extractor,
    content: {
      getFileContent: (...args) => {
        if (!contentResolver) throw new Error('FileContentResolver not initialized');
        return contentResolver.getFileContent(...args);
      },
      invalidateFile: (filePath) => contentResolver?.invalidateFile(filePath),
    },
    authorization: {
      // Legacy Desktop captures a whole local root. Host provides a narrower Team owner here.
      assertTeam() {},
      assertCurrent() {
        if (generation !== ownerGeneration || getTeamsBasePath() !== teamsRoot)
          throw new Error('Review owner changed; reload Changes');
      },
      getConfig: (teamName) => configReader.getConfig(teamName),
    },
    applier: deps.applier,
    processStartProbe: readProcessStartTimeMs,
    logger,
  });
  reviewWatcherRequestGeneration += 1;
  const nextFileWatcher = deps.fileWatcher ?? defaultReviewFileWatcher;
  reviewWatcherEpoch += 1;
  reviewFileWatcher.stop();
  reviewWatcherProjectRoot = null;
  reviewFileWatcher = nextFileWatcher;
  reviewProjectPathValidator = deps.projectPathValidator ?? validateReviewProjectPath;
}
function getWriter(): ReviewWriter {
  if (!writer) throw new Error('Review handlers not initialized');
  return writer;
}

export function registerReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.handle(REVIEW_GET_AGENT_CHANGES, handleGetAgentChanges);
  ipcMain.handle(REVIEW_GET_TASK_CHANGES, handleGetTaskChanges);
  ipcMain.handle(REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES, handleGetTeamTaskChangeSummaries);
  ipcMain.handle(REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES, handleInvalidateTaskChangeSummaries);
  ipcMain.handle(REVIEW_GET_CHANGE_STATS, handleGetChangeStats);
  // Phase 2
  ipcMain.handle(REVIEW_CHECK_CONFLICT, handleCheckConflict);
  ipcMain.handle(REVIEW_REJECT_HUNKS, handleRejectHunks);
  ipcMain.handle(REVIEW_REJECT_FILE, handleRejectFile);
  ipcMain.handle(REVIEW_PREVIEW_REJECT, handlePreviewReject);
  ipcMain.handle(REVIEW_APPLY_DECISIONS, handleApplyDecisions);
  ipcMain.handle(REVIEW_EXECUTE_MUTATION, handleExecuteReviewMutation);
  ipcMain.handle(REVIEW_RETRY_MUTATION_RECOVERY, handleRetryReviewMutationRecovery);
  ipcMain.handle(REVIEW_RESTORE_HISTORY, handleRestoreReviewHistory);
  ipcMain.handle(REVIEW_GET_FILE_CONTENT, handleGetFileContent);
  // Editable diff
  ipcMain.handle(REVIEW_SAVE_EDITED_FILE, handleSaveEditedFile);
  ipcMain.handle(REVIEW_DELETE_EDITED_FILE, handleDeleteEditedFile);
  ipcMain.handle(REVIEW_RESTORE_REJECTED_RENAME, handleRestoreRejectedRename);
  ipcMain.handle(REVIEW_REAPPLY_REJECTED_RENAME, handleReapplyRejectedRename);
  ipcMain.handle(REVIEW_WATCH_FILES, handleWatchReviewFiles);
  ipcMain.handle(REVIEW_UNWATCH_FILES, handleUnwatchReviewFiles);
  // Phase 4
  ipcMain.handle(REVIEW_GET_GIT_FILE_LOG, handleGetGitFileLog);
  // Decision persistence
  ipcMain.handle(REVIEW_LOAD_DECISIONS, handleLoadDecisions);
  ipcMain.handle(REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES, handleLoadDecisionConflictCandidates);
  ipcMain.handle(
    REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
    handleResolveDecisionConflictCandidate
  );
  ipcMain.handle(REVIEW_SAVE_DECISIONS, handleSaveDecisions);
  ipcMain.handle(REVIEW_CLEAR_DECISIONS, handleClearDecisions);
  ipcMain.handle(REVIEW_LOAD_DRAFT_HISTORY, handleLoadDraftHistory);
  ipcMain.handle(
    REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
    handleLoadDraftHistoryConflictCandidates
  );
  ipcMain.handle(
    REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
    handleResolveDraftHistoryConflictCandidate
  );
  ipcMain.handle(
    REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
    handleReplaceDraftHistoryConflictCandidate
  );
  ipcMain.handle(REVIEW_SAVE_DRAFT_HISTORY_ENTRY, handleSaveDraftHistoryEntry);
  ipcMain.handle(REVIEW_CLEAR_DRAFT_HISTORY, handleClearDraftHistory);
}

export function removeReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.removeHandler(REVIEW_GET_AGENT_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TASK_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES);
  ipcMain.removeHandler(REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES);
  ipcMain.removeHandler(REVIEW_GET_CHANGE_STATS);
  // Phase 2
  ipcMain.removeHandler(REVIEW_CHECK_CONFLICT);
  ipcMain.removeHandler(REVIEW_REJECT_HUNKS);
  ipcMain.removeHandler(REVIEW_REJECT_FILE);
  ipcMain.removeHandler(REVIEW_PREVIEW_REJECT);
  ipcMain.removeHandler(REVIEW_APPLY_DECISIONS);
  ipcMain.removeHandler(REVIEW_EXECUTE_MUTATION);
  ipcMain.removeHandler(REVIEW_RETRY_MUTATION_RECOVERY);
  ipcMain.removeHandler(REVIEW_RESTORE_HISTORY);
  ipcMain.removeHandler(REVIEW_GET_FILE_CONTENT);
  // Editable diff
  ipcMain.removeHandler(REVIEW_SAVE_EDITED_FILE);
  ipcMain.removeHandler(REVIEW_DELETE_EDITED_FILE);
  ipcMain.removeHandler(REVIEW_RESTORE_REJECTED_RENAME);
  ipcMain.removeHandler(REVIEW_REAPPLY_REJECTED_RENAME);
  ipcMain.removeHandler(REVIEW_WATCH_FILES);
  ipcMain.removeHandler(REVIEW_UNWATCH_FILES);
  // Phase 4
  ipcMain.removeHandler(REVIEW_GET_GIT_FILE_LOG);
  // Decision persistence
  ipcMain.removeHandler(REVIEW_LOAD_DECISIONS);
  ipcMain.removeHandler(REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES);
  ipcMain.removeHandler(REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE);
  ipcMain.removeHandler(REVIEW_SAVE_DECISIONS);
  ipcMain.removeHandler(REVIEW_CLEAR_DECISIONS);
  ipcMain.removeHandler(REVIEW_LOAD_DRAFT_HISTORY);
  ipcMain.removeHandler(REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES);
  ipcMain.removeHandler(REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE);
  ipcMain.removeHandler(REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE);
  ipcMain.removeHandler(REVIEW_SAVE_DRAFT_HISTORY_ENTRY);
  ipcMain.removeHandler(REVIEW_CLEAR_DRAFT_HISTORY);
  writer?.dispose();
  writer = null;
  ownerGeneration += 1;
  reviewWatcherEpoch += 1;
  reviewFileWatcher.stop();
  reviewWatcherProjectRoot = null;
  reviewWatcherRequestGeneration += 1;
}

function getChangeExtractor(): ChangeExtractorService {
  if (!changeExtractor) throw new Error('Review handlers not initialized');
  return changeExtractor;
}

export function setReviewMainWindow(win: BrowserWindow | null): void {
  reviewMainWindowRef = win;
}

async function handleGetAgentChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<AgentChangeSet>> {
  return wrapReviewHandler('getAgentChanges', () =>
    getChangeExtractor().getAgentChanges(teamName, memberName)
  );
}

function sanitizeTaskChangeOptions(options?: unknown): TaskChangeRequestOptions | undefined {
  if (!options || typeof options !== 'object') {
    return undefined;
  }

  const raw = options as Record<string, unknown>;
  return {
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    since: typeof raw.since === 'string' ? raw.since : undefined,
    intervals: Array.isArray(raw.intervals)
      ? (raw.intervals.filter(
          (i): i is { startedAt: string; completedAt?: string } =>
            Boolean(i) &&
            typeof i === 'object' &&
            typeof (i as Record<string, unknown>).startedAt === 'string' &&
            ((i as Record<string, unknown>).completedAt === undefined ||
              typeof (i as Record<string, unknown>).completedAt === 'string')
        ) as { startedAt: string; completedAt?: string }[])
      : undefined,
    stateBucket:
      raw.stateBucket === 'approved' ||
      raw.stateBucket === 'review' ||
      raw.stateBucket === 'completed' ||
      raw.stateBucket === 'active'
        ? raw.stateBucket
        : undefined,
    summaryOnly: raw.summaryOnly === true,
    forceFresh: raw.forceFresh === true,
    retryBackfill: raw.retryBackfill === true,
  };
}

function sanitizeTeamTaskChangeSummaryRequests(requests: unknown): TeamTaskChangeSummaryRequest[] {
  if (!Array.isArray(requests)) {
    return [];
  }

  const sanitizedRequests: TeamTaskChangeSummaryRequest[] = [];
  const seenTaskIds = new Set<string>();
  for (const request of requests.slice(0, TEAM_TASK_CHANGE_SUMMARY_IPC_RAW_REQUEST_LIMIT)) {
    if (sanitizedRequests.length >= TEAM_TASK_CHANGE_SUMMARY_IPC_UNIQUE_REQUEST_LIMIT) {
      break;
    }
    if (!request || typeof request !== 'object') {
      continue;
    }
    const raw = request as Record<string, unknown>;
    if (typeof raw.taskId !== 'string') {
      continue;
    }
    const taskId = raw.taskId.trim();
    if (!taskId || seenTaskIds.has(taskId)) {
      continue;
    }
    seenTaskIds.add(taskId);
    sanitizedRequests.push({
      taskId,
      options: sanitizeTaskChangeOptions(raw.options),
    });
  }
  return sanitizedRequests;
}

async function handleGetTaskChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskId: string,
  options?: unknown
): Promise<IpcResult<TaskChangeSetV2>> {
  const opts = sanitizeTaskChangeOptions(options);
  return wrapReviewHandler('getTaskChanges', () =>
    getChangeExtractor().getTaskChanges(teamName, taskId, opts)
  );
}

async function handleGetTeamTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  requests: unknown
): Promise<IpcResult<TeamTaskChangeSummariesResponse>> {
  const sanitizedRequests = sanitizeTeamTaskChangeSummaryRequests(requests);

  return wrapReviewHandler('getTeamTaskChangeSummaries', () =>
    getChangeExtractor().getTeamTaskChangeSummaries(teamName, sanitizedRequests)
  );
}

async function handleInvalidateTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskIds: string[]
): Promise<IpcResult<void>> {
  return wrapReviewHandler('invalidateTaskChangeSummaries', async () => {
    await getChangeExtractor().invalidateTaskChangeSummaries(
      teamName,
      Array.isArray(taskIds) ? taskIds.filter((taskId) => typeof taskId === 'string') : []
    );
  });
}

async function handleGetChangeStats(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<ChangeStats>> {
  return wrapReviewHandler('getChangeStats', () =>
    getChangeExtractor().getChangeStats(teamName, memberName)
  );
}

async function handleUnwatchReviewFiles(): Promise<IpcResult<void>> {
  reviewWatcherRequestGeneration += 1;
  reviewWatcherEpoch += 1;
  return wrapReviewHandler('unwatchFiles', async () => {
    reviewFileWatcher.stop();
    reviewWatcherProjectRoot = null;
  });
}

async function validateReviewProjectPath(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Invalid project path');
  }

  if (!path.isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute');
  }

  const normalized = path.resolve(path.normalize(projectPath));
  const stat = await fs.stat(normalized);
  if (!stat.isDirectory()) {
    throw new Error('Project path is not a directory');
  }
  return normalized;
}

async function handleGetGitFileLog(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePath: string
): Promise<IpcResult<{ hash: string; timestamp: string; message: string }[]>> {
  return wrapReviewHandler('getGitFileLog', async () => {
    if (!gitDiffFallback) {
      return [];
    }
    return gitDiffFallback.getFileLog(projectPath, filePath);
  });
}

async function handleWatchReviewFiles(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePaths: string[]
): Promise<IpcResult<void>> {
  const requestGeneration = ++reviewWatcherRequestGeneration;
  return wrapReviewHandler('watchFiles', async () => {
    const normalizedProjectPath = await reviewProjectPathValidator(projectPath);
    if (requestGeneration !== reviewWatcherRequestGeneration) return;
    const shouldRestart =
      reviewWatcherProjectRoot !== normalizedProjectPath || !reviewFileWatcher.isWatching();

    if (shouldRestart) {
      const epoch = ++reviewWatcherEpoch;
      reviewFileWatcher.stop();
      reviewWatcherProjectRoot = normalizedProjectPath;
      reviewFileWatcher.start(normalizedProjectPath, (event) => {
        if (epoch === reviewWatcherEpoch)
          safeSendToRenderer(reviewMainWindowRef, REVIEW_FILE_CHANGE, event);
      });
    }

    reviewFileWatcher.setWatchedFiles(Array.isArray(filePaths) ? filePaths : []);
  });
}

async function handleCheckConflict(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['checkConflict']>
) {
  return wrapReviewHandler('checkConflict', () => getWriter().checkConflict(...args));
}

async function handleRejectHunks(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['rejectHunks']>
) {
  return wrapReviewHandler('rejectHunks', () => getWriter().rejectHunks(...args));
}

async function handleRejectFile(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['rejectFile']>
) {
  return wrapReviewHandler('rejectFile', () => getWriter().rejectFile(...args));
}

async function handlePreviewReject(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['previewReject']>
) {
  return wrapReviewHandler('previewReject', () => getWriter().previewReject(...args));
}

async function handleApplyDecisions(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['applyDecisions']>
) {
  return wrapReviewHandler('applyDecisions', () => getWriter().applyDecisions(...args));
}

async function handleExecuteReviewMutation(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['executeReviewMutation']>
) {
  return wrapReviewHandler('executeReviewMutation', () =>
    getWriter().executeReviewMutation(...args)
  );
}

async function handleRestoreReviewHistory(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['restoreReviewHistory']>
) {
  return wrapReviewHandler('restoreReviewHistory', () => getWriter().restoreReviewHistory(...args));
}

async function handleGetFileContent(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['getFileContent']>
) {
  return wrapReviewHandler('getFileContent', () => getWriter().getFileContent(...args));
}

async function handleSaveEditedFile(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['saveEditedFile']>
) {
  return wrapReviewHandler('saveEditedFile', () => getWriter().saveEditedFile(...args));
}

async function handleDeleteEditedFile(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['deleteEditedFile']>
) {
  return wrapReviewHandler('deleteEditedFile', () => getWriter().deleteEditedFile(...args));
}

async function handleRestoreRejectedRename(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['restoreRejectedRename']>
) {
  return wrapReviewHandler('restoreRejectedRename', () =>
    getWriter().restoreRejectedRename(...args)
  );
}

async function handleReapplyRejectedRename(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['reapplyRejectedRename']>
) {
  return wrapReviewHandler('reapplyRejectedRename', () =>
    getWriter().reapplyRejectedRename(...args)
  );
}

async function handleRetryReviewMutationRecovery(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['retryReviewMutationRecovery']>
) {
  return wrapReviewHandler('retryReviewMutationRecovery', () =>
    getWriter().retryReviewMutationRecovery(...args)
  );
}

async function handleLoadDecisions(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['loadDecisions']>
) {
  return wrapReviewHandler('loadDecisions', () => getWriter().loadDecisions(...args));
}

async function handleLoadDecisionConflictCandidates(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['loadDecisionConflictCandidates']>
) {
  return wrapReviewHandler('loadDecisionConflictCandidates', () =>
    getWriter().loadDecisionConflictCandidates(...args)
  );
}

async function handleResolveDecisionConflictCandidate(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['resolveDecisionConflictCandidate']>
) {
  return wrapReviewHandler('resolveDecisionConflictCandidate', () =>
    getWriter().resolveDecisionConflictCandidate(...args)
  );
}

async function handleSaveDecisions(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['saveDecisions']>
) {
  return wrapReviewHandler('saveDecisions', () => getWriter().saveDecisions(...args));
}

async function handleClearDecisions(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['clearDecisions']>
) {
  return wrapReviewHandler('clearDecisions', () => getWriter().clearDecisions(...args));
}

async function handleLoadDraftHistory(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['loadDraftHistory']>
) {
  return wrapReviewHandler('loadDraftHistory', () => getWriter().loadDraftHistory(...args));
}

async function handleLoadDraftHistoryConflictCandidates(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['loadDraftHistoryConflictCandidates']>
) {
  return wrapReviewHandler('loadDraftHistoryConflictCandidates', () =>
    getWriter().loadDraftHistoryConflictCandidates(...args)
  );
}

async function handleResolveDraftHistoryConflictCandidate(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['resolveDraftHistoryConflictCandidate']>
) {
  return wrapReviewHandler('resolveDraftHistoryConflictCandidate', () =>
    getWriter().resolveDraftHistoryConflictCandidate(...args)
  );
}

async function handleReplaceDraftHistoryConflictCandidate(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['replaceDraftHistoryConflictCandidate']>
) {
  return wrapReviewHandler('replaceDraftHistoryConflictCandidate', () =>
    getWriter().replaceDraftHistoryConflictCandidate(...args)
  );
}

async function handleSaveDraftHistoryEntry(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['saveDraftHistoryEntry']>
) {
  return wrapReviewHandler('saveDraftHistoryEntry', () =>
    getWriter().saveDraftHistoryEntry(...args)
  );
}

async function handleClearDraftHistory(
  _event: IpcMainInvokeEvent,
  ...args: Parameters<ReviewWriter['clearDraftHistory']>
) {
  return wrapReviewHandler('clearDraftHistory', () => getWriter().clearDraftHistory(...args));
}
