/**
 * IPC handlers for code review / diff view feature.
 *
 * Паттерн: module-level state + guard + wrapReviewHandler (как teams.ts)
 */

import {
  assertHunkIndices,
  assertSnippetShapes,
  createReviewDecisionPersistenceFeature,
  createReviewFileWatchFeature,
  createReviewQueryFeature,
  createReviewScopeAuthorizationFeature,
  sanitizeTaskChangeOptions,
  sanitizeTeamTaskChangeSummaryRequests,
} from '@features/change-review/main';
import {
  createReviewDecisionHistoryFeature,
  createReviewDraftHistoryFeature,
  registerReviewDecisionHistoryIpc,
  registerReviewDraftHistoryIpc,
  removeReviewDecisionHistoryIpc,
  removeReviewDraftHistoryIpc,
} from '@features/change-review-history/main';
import {
  assertCurrentReviewDecisionRevision,
  createReviewDecisionBatchFeature,
  createReviewDecisionCommandFeature,
  createReviewEditableMutationFeature,
  createReviewHistoryMutationFeature,
  createReviewMutationRecoveryFeature,
  parseDeleteEditedFileInput,
  parseSaveEditedFileInput,
  registerReviewMutationRecoveryIpc,
  removeReviewMutationRecoveryIpc,
  ReviewMutationCoordinator,
} from '@features/review-mutations/main';
import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { createIpcWrapper } from '@main/ipc/ipcWrapper';
import { ReviewDecisionStore } from '@main/services/team/ReviewDecisionStore';
import { ReviewMutationJournalStore } from '@main/services/team/ReviewMutationJournalStore';
import * as reviewPersistenceLocks from '@main/services/team/ReviewPersistenceScopeLock';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { inspectReviewFileTransaction } from '@main/utils/atomicWrite';
import {
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_DELETE_EDITED_FILE,
  REVIEW_GET_AGENT_CHANGES,
  REVIEW_GET_CHANGE_STATS,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_GET_GIT_FILE_LOG,
  REVIEW_GET_TASK_CHANGES,
  REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES,
  REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES,
  REVIEW_PREVIEW_REJECT,
  REVIEW_REAPPLY_REJECTED_RENAME,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_RESTORE_REJECTED_RENAME,
  REVIEW_SAVE_EDITED_FILE,
  REVIEW_UNWATCH_FILES,
  REVIEW_WATCH_FILES,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { ReviewFileWatcherPort, ReviewPathAuthorization } from '@features/change-review/main';
import type { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import type { FileContentResolver } from '@main/services/team/FileContentResolver';
import type { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import type { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import type { IpcResult } from '@shared/types/ipc';
import type {
  AgentChangeSet,
  ApplyReviewRequest,
  ApplyReviewResult,
  ChangeStats,
  ConflictCheckResult,
  FileChangeSummary,
  FileChangeWithContent,
  RejectResult,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  SnippetDiff,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
} from '@shared/types/review';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const wrapReviewHandler = createIpcWrapper('IPC:review');
const logger = createLogger('IPC:review');
const MAX_REVIEW_DECISIONS = 2_000;

// --- Module-level state ---

let changeExtractor: ChangeExtractorService | null = null;
let reviewApplier: ReviewApplierService | null = null;
let fileContentResolver: FileContentResolver | null = null;
let gitDiffFallback: GitDiffFallback | null = null;
let reviewConfigReader: Pick<TeamConfigReader, 'getConfig'> = new TeamConfigReader();
const reviewDecisionStore = new ReviewDecisionStore();
const reviewMutationJournal = new ReviewMutationJournalStore();
const reviewMutationCoordinator = new ReviewMutationCoordinator(reviewMutationJournal);
export type ReviewFileWatcher = ReviewFileWatcherPort;
const reviewFileWatchFeature = createReviewFileWatchFeature();

function getChangeExtractor(): ChangeExtractorService {
  if (!changeExtractor) throw new Error('Review handlers not initialized');
  return changeExtractor;
}

function getApplier(): ReviewApplierService {
  if (!reviewApplier) throw new Error('ReviewApplierService not initialized');
  return reviewApplier;
}

function getContentResolver(): FileContentResolver {
  if (!fileContentResolver) throw new Error('FileContentResolver not initialized');
  return fileContentResolver;
}

const reviewScopeAuthorizationFeature = createReviewScopeAuthorizationFeature({
  validators: { validateTeamName, validateTaskId },
  config: {
    getConfig: (teamName) => reviewConfigReader.getConfig(teamName),
  },
  changes: {
    getTaskChanges: (teamName, taskId) => getChangeExtractor().getTaskChanges(teamName, taskId),
    getAgentChanges: (teamName, memberName) =>
      getChangeExtractor().getAgentChanges(teamName, memberName),
  },
  content: {
    getFileContent: (...args) => getContentResolver().getFileContent(...args),
    invalidateFile: (filePath) => getContentResolver().invalidateFile(filePath),
  },
});

function parseReviewFileScope(value: unknown): ReviewFileScope {
  return reviewScopeAuthorizationFeature.parseReviewFileScope(value);
}

function parseReviewRenameRecoveryExpectation(value: unknown): ReviewRenameRecoveryExpectation {
  return reviewScopeAuthorizationFeature.parseReviewRenameRecoveryExpectation(value);
}

function normalizeReviewPathForIdentity(filePath: string): string {
  return reviewScopeAuthorizationFeature.normalizeReviewPathForIdentity(filePath);
}

function resolveReviewPathAuthorization(
  scopeValue: unknown,
  options: { requireIdentity?: boolean } = {}
): Promise<{ scope: ReviewFileScope; authorization: ReviewPathAuthorization }> {
  return reviewScopeAuthorizationFeature.resolveReviewPathAuthorization(scopeValue, options);
}

function validateAuthorizedReviewFilePath(
  authorization: ReviewPathAuthorization,
  filePathValue: unknown,
  options: { requireReviewedFile: boolean; rejectHardlinks?: boolean }
): Promise<string> {
  return reviewScopeAuthorizationFeature.validateAuthorizedReviewFilePath(
    authorization,
    filePathValue,
    options
  );
}

function getAuthoritativeReviewedFile(
  authorization: ReviewPathAuthorization,
  filePath: string
): FileChangeSummary {
  return reviewScopeAuthorizationFeature.getAuthoritativeReviewedFile(authorization, filePath);
}

function resolveAuthoritativeFileContent(
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization,
  filePath: string
): Promise<FileChangeWithContent> {
  return reviewScopeAuthorizationFeature.resolveAuthoritativeFileContent(
    scope,
    authorization,
    filePath
  );
}

function assertExpectedAuthoritativeRename(
  content: FileChangeWithContent,
  expectation: ReviewRenameRecoveryExpectation
): void {
  reviewScopeAuthorizationFeature.assertExpectedAuthoritativeRename(content, expectation);
}

function invalidateAuthoritativeReviewContent(content: FileChangeWithContent): void {
  reviewScopeAuthorizationFeature.invalidateAuthoritativeReviewContent(content);
}

function validateSnippetPaths(
  authorization: ReviewPathAuthorization,
  snippets: SnippetDiff[],
  options: { requireReviewedFile?: boolean; rejectHardlinks?: boolean } = {}
): Promise<void> {
  return reviewScopeAuthorizationFeature.validateSnippetPaths(authorization, snippets, options);
}

const reviewDecisionPersistenceFeature = createReviewDecisionPersistenceFeature({
  scope: {
    parse: parseReviewFileScope,
    resolve: resolveReviewPathAuthorization,
    normalizeIdentityPath: normalizeReviewPathForIdentity,
    validateFilePath: validateAuthorizedReviewFilePath,
    getAuthoritativeFile: getAuthoritativeReviewedFile,
  },
  paths: {
    isAbsoluteNormalized: (filePath) => path.isAbsolute(path.normalize(filePath)),
  },
  locks: {
    withLogicalScopeLock: reviewPersistenceLocks.withReviewPersistenceLogicalScopeLock,
    withPersistenceScopeLock: reviewPersistenceLocks.withReviewPersistenceScopeLock,
  },
});

// --- Forward-compatible config object ---

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
  // Handler reinitialization supersedes validation still pending from the
  // previous registration, even when both registrations reuse one watcher.
  reviewFileWatchFeature.supersedePendingRequests();
  changeExtractor = deps.extractor;
  if (deps.applier) reviewApplier = deps.applier;
  if (deps.contentResolver) fileContentResolver = deps.contentResolver;
  if (deps.gitFallback) gitDiffFallback = deps.gitFallback;
  reviewConfigReader = deps.configReader ?? new TeamConfigReader();
  reviewFileWatchFeature.configure({
    fileWatcher: deps.fileWatcher,
    projectPathValidator: deps.projectPathValidator,
  });
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
  registerReviewMutationRecoveryIpc(ipcMain, reviewMutationRecoveryFeature, wrapReviewHandler);
  registerReviewDecisionHistoryIpc(ipcMain, reviewDecisionHistoryFeature, wrapReviewHandler);
  registerReviewDraftHistoryIpc(ipcMain, reviewDraftHistoryFeature, wrapReviewHandler);
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
  removeReviewMutationRecoveryIpc(ipcMain);
  removeReviewDecisionHistoryIpc(ipcMain);
  removeReviewDraftHistoryIpc(ipcMain);
  reviewFileWatchFeature.dispose();
}

export function setReviewMainWindow(win: BrowserWindow | null): void {
  reviewFileWatchFeature.setMainWindow(win);
}

// --- Phase 1 Handlers ---

async function handleGetAgentChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<AgentChangeSet>> {
  return wrapReviewHandler('getAgentChanges', () =>
    reviewQueryFeature.getAgentChanges(teamName, memberName)
  );
}

async function handleGetTaskChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskId: string,
  options?: unknown
): Promise<IpcResult<TaskChangeSetV2>> {
  const opts = sanitizeTaskChangeOptions(options);

  return wrapReviewHandler('getTaskChanges', () =>
    reviewQueryFeature.getTaskChanges(teamName, taskId, opts)
  );
}

async function handleGetTeamTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  requests: unknown
): Promise<IpcResult<TeamTaskChangeSummariesResponse>> {
  const sanitizedRequests = sanitizeTeamTaskChangeSummaryRequests(requests);

  return wrapReviewHandler('getTeamTaskChangeSummaries', () =>
    reviewQueryFeature.getTeamTaskChangeSummaries(teamName, sanitizedRequests)
  );
}

async function handleInvalidateTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskIds: string[]
): Promise<IpcResult<void>> {
  return wrapReviewHandler('invalidateTaskChangeSummaries', () =>
    reviewQueryFeature.invalidateTaskChangeSummaries(teamName, taskIds)
  );
}

async function handleGetChangeStats(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<ChangeStats>> {
  return wrapReviewHandler('getChangeStats', () =>
    reviewQueryFeature.getChangeStats(teamName, memberName)
  );
}

// --- Phase 2 Handlers ---

async function handleCheckConflict(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedModified: unknown
): Promise<IpcResult<ConflictCheckResult>> {
  return wrapReviewHandler('checkConflict', () => {
    if (typeof expectedModified !== 'string') {
      throw new Error('Invalid expectedModified');
    }
    return reviewDecisionCommandFeature.checkConflict(scopeValue, filePathValue, expectedModified);
  });
}

async function handleRejectHunks(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  hunkIndices: unknown
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectHunks', () => {
    assertHunkIndices(hunkIndices);
    return reviewDecisionCommandFeature.rejectHunks(scopeValue, filePathValue, hunkIndices);
  });
}

async function handleRejectFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectFile', () =>
    reviewDecisionCommandFeature.rejectFile(scopeValue, filePathValue)
  );
}

async function handlePreviewReject(
  _event: IpcMainInvokeEvent,
  filePath: string,
  original: string,
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[]
): Promise<IpcResult<{ preview: string; hasConflicts: boolean }>> {
  return wrapReviewHandler('previewReject', () =>
    reviewDecisionCommandFeature.previewReject(filePath, original, modified, hunkIndices, snippets)
  );
}

async function handleApplyDecisions(
  _event: IpcMainInvokeEvent,
  requestValue: unknown
): Promise<IpcResult<ApplyReviewResult>> {
  if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    return { success: false, error: 'Invalid request object' };
  }
  const request = requestValue as ApplyReviewRequest;
  if (!Array.isArray(request.decisions) || request.decisions.length > MAX_REVIEW_DECISIONS) {
    return { success: false, error: 'Invalid request: decisions array required' };
  }
  return wrapReviewHandler('applyDecisions', () =>
    reviewDecisionCommandFeature.applyDecisions(request)
  );
}

const reviewDecisionBatchFeature = createReviewDecisionBatchFeature({
  scope: {
    parse: parseReviewFileScope,
    normalizeIdentityPath: normalizeReviewPathForIdentity,
  },
  journal: reviewMutationJournal,
  applier: {
    applyReviewDecisions: (...args) => getApplier().applyReviewDecisions(...args),
    finalizeReviewDiskTransitions: (...args) =>
      getApplier().finalizeReviewDiskTransitions?.(...args) ?? Promise.resolve(),
  },
  persistence: reviewDecisionStore,
  files: {
    readText: (filePath) => fs.readFile(filePath, 'utf8'),
    inspectTransaction: inspectReviewFileTransaction,
  },
  cache: {
    invalidateAuthoritativeContent: invalidateAuthoritativeReviewContent,
  },
  logger: {
    warn: (message, error) => logger.warn(message, error),
    error: (message, error) => logger.error(message, error),
  },
});

const reviewHistoryMutationFeature = createReviewHistoryMutationFeature({
  scope: {
    validateFilePath: validateAuthorizedReviewFilePath,
    getAuthoritativeFile: getAuthoritativeReviewedFile,
    resolveAuthoritativeContent: resolveAuthoritativeFileContent,
    parseRenameExpectation: parseReviewRenameRecoveryExpectation,
    assertExpectedRename: assertExpectedAuthoritativeRename,
    normalizeIdentityPath: normalizeReviewPathForIdentity,
  },
  files: {
    readText: (filePath) => fs.readFile(filePath, 'utf8'),
  },
});

const reviewEditableMutationFeature = createReviewEditableMutationFeature({
  scope: reviewScopeAuthorizationFeature,
  applier: {
    saveEditedFile: (...args) => getApplier().saveEditedFile(...args),
    deleteEditedFile: (...args) => getApplier().deleteEditedFile(...args),
    restoreRejectedRename: (...args) => getApplier().restoreRejectedRename(...args),
    reapplyRejectedRename: (...args) => getApplier().reapplyRejectedRename(...args),
  },
  content: {
    invalidateFile: (filePath) => getContentResolver().invalidateFile(filePath),
  },
});

const reviewMutationRecoveryFeature = createReviewMutationRecoveryFeature({
  scope: {
    parse: parseReviewFileScope,
    resolve: resolveReviewPathAuthorization,
    parsePersistenceScope: (value, scope) =>
      reviewDecisionPersistenceFeature.parsePersistenceScope(value, scope),
    validateFilePath: validateAuthorizedReviewFilePath,
    validateSnippets: validateSnippetPaths,
    resolveAuthoritativeContent: resolveAuthoritativeFileContent,
    assertExpectedRename: assertExpectedAuthoritativeRename,
    parseRenameExpectation: parseReviewRenameRecoveryExpectation,
    assertDecisionShape: (value) => reviewDecisionPersistenceFeature.assertDecisionShape(value),
    assertSnippetShapes,
    getAuthoritativeFile: getAuthoritativeReviewedFile,
    normalizeIdentityPath: normalizeReviewPathForIdentity,
    normalizeFilesystemPath: (filePath) => path.resolve(path.normalize(filePath)),
  },
  decisions: {
    withLock: (teamName, persistenceScope, operation) =>
      reviewDecisionPersistenceFeature.withLock(teamName, persistenceScope, operation),
    assertValidSnapshot: (value) => reviewDecisionStore.assertValidSnapshot(value),
    assertCurrentRevision: async (teamName, persistenceScope, expectedRevision) => {
      const current = await reviewDecisionStore.load(
        teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      );
      assertCurrentReviewDecisionRevision(current, expectedRevision);
    },
    load: (teamName, persistenceScope) =>
      reviewDecisionStore.load(teamName, persistenceScope.scopeKey, persistenceScope.scopeToken),
    commit: (record) => reviewDecisionBatchFeature.commit(record),
    assertExactTransition: (request, current, authorization) =>
      reviewHistoryMutationFeature.assertExactTransition(request, current, authorization),
    bindAuthoritativeForwardMutation: (request, current, scope, authorization) =>
      reviewHistoryMutationFeature.bindAuthoritativeForwardMutation(
        request,
        current,
        scope,
        authorization
      ),
    assertAuthoritativelyBoundAction: (action) =>
      reviewHistoryMutationFeature.assertAuthoritativelyBoundAction(action),
  },
  journal: reviewMutationJournal,
  coordinator: reviewMutationCoordinator,
  applier: {
    getRejectedRenamePostimages: (...args) => getApplier().getRejectedRenamePostimages(...args),
    classifyEditedFileTransition: (...args) => getApplier().classifyEditedFileTransition(...args),
    classifyRejectedRenameTransition: (...args) =>
      getApplier().classifyRejectedRenameTransition(...args),
    saveEditedFile: (...args) => getApplier().saveEditedFile(...args),
    deleteEditedFile: (...args) => getApplier().deleteEditedFile(...args),
    restoreRejectedRename: (...args) => getApplier().restoreRejectedRename(...args),
    reapplyRejectedRename: (...args) => getApplier().reapplyRejectedRename(...args),
    finalizeEditedFileTransaction: (...args) =>
      getApplier().finalizeEditedFileTransaction?.(...args) ?? Promise.resolve(),
    finalizeRejectedRenameTransaction: (...args) =>
      getApplier().finalizeRejectedRenameTransaction?.(...args) ?? Promise.resolve(),
  },
  cache: {
    invalidateAuthoritativeContent: invalidateAuthoritativeReviewContent,
    invalidateFile: (filePath) => getContentResolver().invalidateFile(filePath),
  },
  applyDecisionBatchDisk: (record) => reviewDecisionBatchFeature.applyDisk(record),
  logger: {
    warn: (message, error) => logger.warn(message, error),
    error: (message, error) => logger.error(message, error),
  },
});

const reviewDecisionCommandFeature = createReviewDecisionCommandFeature({
  scope: {
    resolve: resolveReviewPathAuthorization,
    parsePersistenceScope: (value, scope) =>
      reviewDecisionPersistenceFeature.parsePersistenceScope(value, scope),
    validateFilePath: validateAuthorizedReviewFilePath,
    validateSnippets: validateSnippetPaths,
    assertDecisionShape: (value) => reviewDecisionPersistenceFeature.assertDecisionShape(value),
    assertSnippetShapes,
    getAuthoritativeFile: getAuthoritativeReviewedFile,
    resolveAuthoritativeContent: resolveAuthoritativeFileContent,
    normalizeIdentityPath: normalizeReviewPathForIdentity,
  },
  applier: {
    checkConflict: (...args) => getApplier().checkConflict(...args),
    rejectHunks: (...args) => getApplier().rejectHunks(...args),
    rejectFile: (...args) => getApplier().rejectFile(...args),
    previewReject: (...args) => getApplier().previewReject(...args),
    applyReviewDecisions: (...args) => getApplier().applyReviewDecisions(...args),
  },
  persistence: {
    withLock: (teamName, persistenceScope, operation) =>
      reviewDecisionPersistenceFeature.withLock(teamName, persistenceScope, operation),
    assertValidSnapshot: (value) => reviewDecisionStore.assertValidSnapshot(value),
    load: (teamName, persistenceScope) =>
      reviewDecisionStore.load(teamName, persistenceScope.scopeKey, persistenceScope.scopeToken),
  },
  batch: {
    assertPersistedStateIncludesDecisions: (state, decisions) =>
      reviewDecisionBatchFeature.assertPersistedStateIncludesDecisions(state, decisions),
    applyDisk: (record, onResult, onPostimages) =>
      reviewDecisionBatchFeature.applyDisk(record, onResult, onPostimages),
    commit: (record) => reviewDecisionBatchFeature.commit(record),
  },
  history: {
    bindNewHistorySnapshots: (state, current, scope, authorization) =>
      reviewHistoryMutationFeature.bindNewHistorySnapshots(state, current, scope, authorization),
  },
  recovery: {
    recoverPending: (teamName, persistenceScope) =>
      reviewMutationRecoveryFeature.recoverPending(teamName, persistenceScope),
  },
  coordinator: {
    execute: (input, steps) => reviewMutationCoordinator.execute(input, steps),
  },
  cache: {
    invalidateFile: (filePath) => getContentResolver().invalidateFile(filePath),
  },
  logger: {
    debug: (message, error) => logger.debug(message, error),
  },
});

const reviewQueryFeature = createReviewQueryFeature({
  changes: {
    getAgentChanges: (...args) => getChangeExtractor().getAgentChanges(...args),
    getTaskChanges: (...args) => getChangeExtractor().getTaskChanges(...args),
    getTeamTaskChangeSummaries: (...args) =>
      getChangeExtractor().getTeamTaskChangeSummaries(...args),
    invalidateTaskChangeSummaries: (...args) =>
      getChangeExtractor().invalidateTaskChangeSummaries(...args),
    getChangeStats: (...args) => getChangeExtractor().getChangeStats(...args),
  },
  scope: {
    normalizeIdentity: (value) => reviewScopeAuthorizationFeature.normalizeReviewIdentity(value),
    resolve: (value) => resolveReviewPathAuthorization(value),
    validateFilePath: (authorization, filePath, options) =>
      validateAuthorizedReviewFilePath(authorization, filePath, options),
    validateSnippets: (authorization, snippets) => validateSnippetPaths(authorization, snippets),
  },
  content: {
    getFileContent: (...args) => getContentResolver().getFileContent(...args),
  },
  snapshots: {
    register: (...args) => reviewDecisionCommandFeature.registerDisplayedReviewSnapshot(...args),
  },
  gitHistory: {
    getFileLog: (projectPath, filePath) =>
      gitDiffFallback ? gitDiffFallback.getFileLog(projectPath, filePath) : Promise.resolve([]),
  },
});

const reviewDecisionHistoryFeature = createReviewDecisionHistoryFeature({
  lock: {
    run: (teamName, persistenceScope, operation) =>
      reviewDecisionPersistenceFeature.withLock(teamName, persistenceScope, operation),
  },
  authorization: {
    authorize: (teamName, scopeKey) =>
      reviewDecisionPersistenceFeature.authorizeDecisionHistoryScope(teamName, scopeKey),
  },
  queries: reviewDecisionStore,
  mutations: reviewDecisionStore,
  validation: reviewDecisionStore,
  recovery: {
    recover: (teamName, persistenceScope) =>
      reviewMutationRecoveryFeature.recoverPending(teamName, persistenceScope),
    inspectForDiscard: async (teamName, persistenceScope) => {
      const inspection = await reviewMutationJournal.inspectForRecoveryDiscard(
        teamName,
        persistenceScope
      );
      return {
        containsPotentialDiskMutation: inspection.records.some(
          (record) => record.decisions.length > 0 || (record.diskSteps?.length ?? 0) > 0
        ),
        corruptRecordCount: inspection.corruptRecordCount,
      };
    },
    quarantineCorruptScope: async (teamName, persistenceScope) => {
      await reviewMutationJournal.quarantineCorruptScope(teamName, persistenceScope);
    },
    clearScope: (teamName, persistenceScope) =>
      reviewMutationJournal.clearScope(teamName, persistenceScope),
  },
});

const reviewDraftHistoryFeature = createReviewDraftHistoryFeature({
  lock: {
    run: (teamName, persistenceScope, operation) =>
      reviewDecisionPersistenceFeature.withLock(teamName, persistenceScope, operation),
  },
  authorization: {
    authorize: (teamName, scopeKey) =>
      reviewDecisionPersistenceFeature.authorizeDraftHistoryScope(teamName, scopeKey),
  },
});

async function handleGetFileContent(
  _event: IpcMainInvokeEvent,
  teamNameValue: unknown,
  memberNameValue: unknown,
  filePathValue: unknown,
  snippetsValue: unknown = []
): Promise<IpcResult<FileChangeWithContent>> {
  return wrapReviewHandler('getFileContent', () =>
    reviewQueryFeature.getFileContent(teamNameValue, memberNameValue, filePathValue, snippetsValue)
  );
}

// --- Editable diff Handlers ---

async function handleSaveEditedFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  content: unknown,
  expectedCurrentContent: string | null | undefined
): Promise<IpcResult<{ success: boolean }>> {
  const input = parseSaveEditedFileInput(filePathValue, content, expectedCurrentContent);
  if (!input) {
    return { success: false, error: 'Invalid parameters' };
  }
  return wrapReviewHandler('saveEditedFile', () =>
    reviewEditableMutationFeature.saveEditedFile(scopeValue, input)
  );
}

async function handleDeleteEditedFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedCurrentContent: unknown
): Promise<IpcResult<{ success: boolean }>> {
  const input = parseDeleteEditedFileInput(filePathValue, expectedCurrentContent);
  if (!input) {
    return { success: false, error: 'Invalid parameters' };
  }
  return wrapReviewHandler('deleteEditedFile', () =>
    reviewEditableMutationFeature.deleteEditedFile(scopeValue, input)
  );
}

async function handleRestoreRejectedRename(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<IpcResult<{ success: boolean }>> {
  return wrapReviewHandler('restoreRejectedRename', () =>
    reviewEditableMutationFeature.restoreRejectedRename(scopeValue, filePathValue, expectationValue)
  );
}

async function handleReapplyRejectedRename(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<IpcResult<{ success: boolean }>> {
  return wrapReviewHandler('reapplyRejectedRename', () =>
    reviewEditableMutationFeature.reapplyRejectedRename(scopeValue, filePathValue, expectationValue)
  );
}

async function handleWatchReviewFiles(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePaths: string[]
): Promise<IpcResult<void>> {
  const operation = reviewFileWatchFeature.prepareWatch(projectPath, filePaths);
  return wrapReviewHandler('watchFiles', operation);
}

async function handleUnwatchReviewFiles(): Promise<IpcResult<void>> {
  const operation = reviewFileWatchFeature.prepareUnwatch();
  return wrapReviewHandler('unwatchFiles', operation);
}

// --- Phase 4 Handlers ---

async function handleGetGitFileLog(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePath: string
): Promise<IpcResult<{ hash: string; timestamp: string; message: string }[]>> {
  return wrapReviewHandler('getGitFileLog', () =>
    reviewQueryFeature.getGitFileLog(projectPath, filePath)
  );
}
