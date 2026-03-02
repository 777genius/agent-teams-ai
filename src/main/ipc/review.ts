/**
 * IPC handlers for code review / diff view feature.
 *
 * Паттерн: module-level state + guard + wrapReviewHandler (как teams.ts)
 */

import { createIpcWrapper } from '@main/ipc/ipcWrapper';
import { ReviewDecisionStore } from '@main/services/team/ReviewDecisionStore';
import { validateFilePath } from '@main/utils/pathValidation';
import {
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_CLEAR_DECISIONS,
  REVIEW_GET_AGENT_CHANGES,
  REVIEW_GET_CHANGE_STATS,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_GET_GIT_FILE_LOG,
  REVIEW_GET_TASK_CHANGES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_PREVIEW_REJECT,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_SAVE_DECISIONS,
  REVIEW_SAVE_EDITED_FILE,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

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
  FileChangeWithContent,
  HunkDecision,
  RejectResult,
  SnippetDiff,
  TaskChangeSetV2,
} from '@shared/types/review';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const wrapReviewHandler = createIpcWrapper('IPC:review');
const logger = createLogger('IPC:review');

// --- Module-level state ---

let changeExtractor: ChangeExtractorService | null = null;
let reviewApplier: ReviewApplierService | null = null;
let fileContentResolver: FileContentResolver | null = null;
let gitDiffFallback: GitDiffFallback | null = null;
const reviewDecisionStore = new ReviewDecisionStore();

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

// --- Forward-compatible config object ---

export interface ReviewHandlerDeps {
  extractor: ChangeExtractorService;
  applier?: ReviewApplierService;
  contentResolver?: FileContentResolver;
  gitFallback?: GitDiffFallback;
}

export function initializeReviewHandlers(deps: ReviewHandlerDeps): void {
  changeExtractor = deps.extractor;
  if (deps.applier) reviewApplier = deps.applier;
  if (deps.contentResolver) fileContentResolver = deps.contentResolver;
  if (deps.gitFallback) gitDiffFallback = deps.gitFallback;
}

export function registerReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.handle(REVIEW_GET_AGENT_CHANGES, handleGetAgentChanges);
  ipcMain.handle(REVIEW_GET_TASK_CHANGES, handleGetTaskChanges);
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
  // Phase 4
  ipcMain.handle(REVIEW_GET_GIT_FILE_LOG, handleGetGitFileLog);
  // Decision persistence
  ipcMain.handle(REVIEW_LOAD_DECISIONS, handleLoadDecisions);
  ipcMain.handle(REVIEW_SAVE_DECISIONS, handleSaveDecisions);
  ipcMain.handle(REVIEW_CLEAR_DECISIONS, handleClearDecisions);
}

export function removeReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.removeHandler(REVIEW_GET_AGENT_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TASK_CHANGES);
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
  // Phase 4
  ipcMain.removeHandler(REVIEW_GET_GIT_FILE_LOG);
  // Decision persistence
  ipcMain.removeHandler(REVIEW_LOAD_DECISIONS);
  ipcMain.removeHandler(REVIEW_SAVE_DECISIONS);
  ipcMain.removeHandler(REVIEW_CLEAR_DECISIONS);
}

// --- Phase 1 Handlers ---

async function handleGetAgentChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<AgentChangeSet>> {
  return wrapReviewHandler('getAgentChanges', () =>
    getChangeExtractor().getAgentChanges(teamName, memberName)
  );
}

async function handleGetTaskChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskId: string
): Promise<IpcResult<TaskChangeSetV2>> {
  return wrapReviewHandler('getTaskChanges', () =>
    getChangeExtractor().getTaskChanges(teamName, taskId)
  );
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

// --- Phase 2 Handlers ---

async function handleCheckConflict(
  _event: IpcMainInvokeEvent,
  filePath: string,
  expectedModified: string
): Promise<IpcResult<ConflictCheckResult>> {
  return wrapReviewHandler('checkConflict', () =>
    getApplier().checkConflict(filePath, expectedModified)
  );
}

async function handleRejectHunks(
  _event: IpcMainInvokeEvent,
  teamName: string,
  filePath: string,
  original: string,
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[]
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectHunks', () =>
    getApplier().rejectHunks(teamName, filePath, original, modified, hunkIndices, snippets)
  );
}

async function handleRejectFile(
  _event: IpcMainInvokeEvent,
  teamName: string,
  filePath: string,
  original: string,
  modified: string
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectFile', () =>
    getApplier().rejectFile(teamName, filePath, original, modified)
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
    getApplier().previewReject(filePath, original, modified, hunkIndices, snippets)
  );
}

async function handleApplyDecisions(
  _event: IpcMainInvokeEvent,
  request: ApplyReviewRequest
): Promise<IpcResult<ApplyReviewResult>> {
  if (!request || !Array.isArray(request.decisions)) {
    return { success: false, error: 'Invalid request: decisions array required' };
  }
  return wrapReviewHandler('applyDecisions', async () => {
    // Build file contents map for the applier. Prefer renderer-provided context
    // (snippets + full contents), falling back to resolver when missing.
    const fileContents = new Map<string, FileChangeWithContent>();
    const memberName = request.memberName ?? '';

    for (const d of request.decisions) {
      const snippets = d.snippets ?? [];

      // If renderer provided full contents, use them directly.
      if (d.originalFullContent !== undefined || d.modifiedFullContent !== undefined) {
        fileContents.set(d.filePath, {
          filePath: d.filePath,
          relativePath: d.filePath.split('/').slice(-3).join('/'),
          snippets,
          linesAdded: 0,
          linesRemoved: 0,
          isNewFile: d.isNewFile ?? snippets.some((s) => s.type === 'write-new'),
          originalFullContent: d.originalFullContent ?? null,
          modifiedFullContent: d.modifiedFullContent ?? null,
          // Source is informational only; "unavailable" avoids lying.
          contentSource: 'unavailable',
        });
        continue;
      }

      // Fallback: resolve in main process (best-effort; task mode may not have memberName).
      const resolved = await getContentResolver().getFileContent(
        request.teamName,
        memberName,
        d.filePath,
        snippets
      );
      fileContents.set(d.filePath, resolved);
    }

    return getApplier().applyReviewDecisions(request, fileContents);
  });
}

async function handleGetFileContent(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string,
  filePath: string,
  snippets: SnippetDiff[] = []
): Promise<IpcResult<FileChangeWithContent>> {
  return wrapReviewHandler('getFileContent', () =>
    getContentResolver().getFileContent(teamName, memberName, filePath, snippets)
  );
}

// --- Editable diff Handlers ---

async function handleSaveEditedFile(
  _event: IpcMainInvokeEvent,
  filePath: string,
  content: string,
  projectPath?: string
): Promise<IpcResult<{ success: boolean }>> {
  if (!filePath || typeof content !== 'string') {
    return { success: false, error: 'Invalid parameters' };
  }
  const resolvedProjectPath = projectPath && typeof projectPath === 'string' ? projectPath : null;
  const pathCheck = validateFilePath(filePath, resolvedProjectPath);
  if (!pathCheck.valid) {
    logger.error(`saveEditedFile blocked: ${String(pathCheck.error)} (path: ${String(filePath)})`);
    return { success: false, error: `Path validation failed: ${String(pathCheck.error)}` };
  }
  return wrapReviewHandler('saveEditedFile', async () => {
    const result = await getApplier().saveEditedFile(pathCheck.normalizedPath!, content);
    // Invalidate cached content so next fetch reads the saved version from disk
    getContentResolver().invalidateFile(pathCheck.normalizedPath!);
    return result;
  });
}

// --- Phase 4 Handlers ---

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

// --- Decision Persistence Handlers ---

async function handleLoadDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string
): Promise<
  IpcResult<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null>
> {
  return wrapReviewHandler('loadDecisions', () => reviewDecisionStore.load(teamName, scopeKey));
}

async function handleSaveDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  hunkDecisions: Record<string, HunkDecision>,
  fileDecisions: Record<string, HunkDecision>,
  hunkContextHashesByFile: Record<string, Record<number, string>> | null = null
): Promise<IpcResult<void>> {
  return wrapReviewHandler('saveDecisions', () =>
    reviewDecisionStore.save(teamName, scopeKey, {
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile: hunkContextHashesByFile ?? undefined,
    })
  );
}

async function handleClearDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string
): Promise<IpcResult<void>> {
  return wrapReviewHandler('clearDecisions', () => reviewDecisionStore.clear(teamName, scopeKey));
}
