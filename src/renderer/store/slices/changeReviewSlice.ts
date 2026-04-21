import { api } from '@renderer/api';
import {
  buildTaskChangePresenceKey,
  isTaskSummaryCacheableForOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import {
  getReviewChangeSetIdentityToken,
  type ReviewChangeSetLike,
} from '@renderer/utils/reviewDecisionScope';
import {
  buildHunkDecisionKey,
  getFileReviewKey,
  getReviewKeyForFilePath,
  normalizePersistedReviewState,
} from '@renderer/utils/reviewKey';
import {
  resolveTaskChangePresenceFromResult,
  shouldBackgroundRevalidateTaskPresence,
} from '@renderer/utils/taskChangePresence';
import { computeDiffContextHash } from '@shared/utils/diffContextHash';
import { createLogger } from '@shared/utils/logger';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { structuredPatch } from 'diff';

/** Tracks in-flight checkTaskHasChanges calls to avoid duplicate requests */
const taskChangesCheckInFlight = new Set<string>();
/** Tracks background presence revalidation for optimistic terminal summary hits */
const taskChangesPresenceRevalidationInFlight = new Set<string>();
/** Negative results cached with timestamp — recheck after 30s */
const taskChangesNegativeCache = new Map<string, number>();
const NEGATIVE_CACHE_TTL = 30_000;
const TASK_CHANGE_WARM_CONCURRENCY = 4;
const CHANGE_REVIEW_SLICE_BOOT_TIME = Date.now();
let latestAgentChangesRequestToken = 0;
let latestTaskChangesRequestToken = 0;
let latestDecisionLoadRequestToken = 0;

/** Debounce timer for persisting decisions to disk */
const persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 500;

import type { AppState } from '../types';
import type {
  AgentChangeSet,
  ApplyReviewRequest,
  ApplyReviewResult,
  ChangeStats,
  FileChangeSummary,
  FileChangeWithContent,
  FileReviewDecision,
  HunkDecision,
  SnippetDiff,
  TaskChangeSet,
  TaskChangeSetV2,
  TaskChangePresenceState,
} from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('changeReviewSlice');

function reviewPathsEqual(left: string, right: string): boolean {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function findReviewFileByPath(
  files: readonly FileChangeSummary[] | null | undefined,
  filePath: string
): FileChangeSummary | undefined {
  return files?.find((file) => reviewPathsEqual(file.filePath, filePath));
}

/** Snapshot of review decisions for undo support */
interface DecisionSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export interface ReviewExternalChange {
  type: 'change' | 'add' | 'unlink';
}

const MAX_REVIEW_UNDO_DEPTH = 10;

/**
 * When true, rejected hunks are immediately applied to disk (no need for "Apply All Changes").
 * When false, decisions are batched and applied manually via "Apply All Changes" button.
 */
export const REVIEW_INSTANT_APPLY = true;

function mapReviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('conflict')) return 'File has been modified since agent changes.';
  if (message.includes('ENOENT')) return 'File no longer exists on disk.';
  if (message.includes('EACCES') || message.includes('Permission')) return 'Permission denied.';
  return message || 'Failed to apply review changes';
}

function clearPersistDecisionTimer(scopeStorageKey: string): void {
  const timer = persistDebounceTimers.get(scopeStorageKey);
  if (!timer) return;
  clearTimeout(timer);
  persistDebounceTimers.delete(scopeStorageKey);
}

function buildPersistDecisionScopeKey(
  teamName: string,
  scopeKey: string,
  scopeToken?: string
): string {
  return scopeToken ? `${teamName}:${scopeKey}:${scopeToken}` : `${teamName}:${scopeKey}`;
}

function clearAllPersistDecisionTimers(): void {
  for (const timer of persistDebounceTimers.values()) {
    clearTimeout(timer);
  }
  persistDebounceTimers.clear();
}

function applyTaskChangePresenceCacheUpdate(
  taskChangePresenceByKey: Record<string, Exclude<TaskChangePresenceState, 'unknown'>>,
  cacheKey: string,
  presence: TaskChangePresenceState | null
): Record<string, Exclude<TaskChangePresenceState, 'unknown'>> {
  const nextTaskChangePresenceByKey = { ...taskChangePresenceByKey };
  if (presence && presence !== 'unknown') {
    nextTaskChangePresenceByKey[cacheKey] = presence;
  } else {
    delete nextTaskChangePresenceByKey[cacheKey];
  }
  return nextTaskChangePresenceByKey;
}

function syncTaskChangeNegativeCache(
  cacheKey: string,
  presence: TaskChangePresenceState | null
): void {
  if (presence === 'has_changes' || presence === 'needs_attention') {
    taskChangesNegativeCache.delete(cacheKey);
  } else if (presence === 'no_changes') {
    taskChangesNegativeCache.set(cacheKey, Date.now());
  } else {
    taskChangesNegativeCache.delete(cacheKey);
  }
}

export interface ChangeReviewSlice {
  // Phase 1 state
  activeChangeSet: AgentChangeSet | TaskChangeSet | TaskChangeSetV2 | null;
  activeTaskChangeRequestOptions: TaskChangeRequestOptions | null;
  changeSetLoading: boolean;
  changeSetError: string | null;
  selectedReviewFilePath: string | null;
  changeStatsCache: Record<string, ChangeStats>;

  // Phase 2 state
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  /** Actual CodeMirror chunk count per file (may differ from snippets.length) */
  fileChunkCounts: Record<string, number>;
  /** Undo stack for bulk review operations (Accept All / Reject All) */
  reviewUndoStack: DecisionSnapshot[];
  /** filePath -> (hunkIndex -> contextHash), persisted for robust replay */
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  changeSetEpoch: number;
  fileContentVersionByPath: Record<string, number>;
  reviewExternalChangesByFile: Record<string, ReviewExternalChange>;
  collapseUnchanged: boolean;
  applyError: string | null;
  applying: boolean;

  // Editable diff state
  editedContents: Record<string, string>;

  /** Cache: "teamName:taskId:signature" → resolved task change presence */
  taskChangePresenceByKey: Record<string, Exclude<TaskChangePresenceState, 'unknown'>>;

  // Phase 1 actions
  fetchAgentChanges: (teamName: string, memberName: string) => Promise<void>;
  fetchTaskChanges: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<void>;
  recordTaskChangePresence: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions,
    presence: TaskChangePresenceState | null
  ) => void;
  selectReviewFile: (filePath: string | null) => void;
  clearChangeReview: () => void;
  clearChangeReviewCache: () => void;
  resetAllReviewState: () => void;
  fetchChangeStats: (teamName: string, memberName: string) => Promise<void>;

  // Decision persistence actions
  loadDecisionsFromDisk: (teamName: string, scopeKey: string, scopeToken: string) => Promise<void>;
  persistDecisions: (teamName: string, scopeKey: string, scopeToken: string) => void;
  clearDecisionsFromDisk: (
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ) => Promise<void>;

  // Phase 2 actions
  /**
   * Set decision for a hunk at the current (visible) CM index.
   * Returns the stable/original hunk index used as the decision key.
   */
  setHunkDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => number;
  /** Clear a persisted decision using the stable/original hunk index */
  clearHunkDecisionByOriginalIndex: (filePath: string, originalIndex: number) => void;
  setFileDecision: (filePath: string, decision: HunkDecision) => void;
  setFileChunkCount: (filePath: string, count: number) => void;
  pushReviewUndoSnapshot: () => void;
  undoBulkReview: () => boolean;
  acceptAllFile: (filePath: string) => void;
  rejectAllFile: (filePath: string) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  setCollapseUnchanged: (collapse: boolean) => void;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  applyReview: (teamName: string, taskId?: string, memberName?: string) => Promise<void>;
  applySingleFileDecision: (
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ) => Promise<ApplyReviewResult | null>;
  /** Remove a file from the current review set (used for rejecting new files) */
  removeReviewFile: (filePath: string) => void;
  /** Re-add a file to the current review set (used for undoing new-file reject) */
  addReviewFile: (
    file: FileChangeSummary,
    options?: { index?: number; content?: FileChangeWithContent }
  ) => void;
  /**
   * Clear in-memory review state for a single file after applying changes to disk.
   * Prevents stale decisions from being re-applied later and forces fresh content resolve.
   */
  clearReviewStateForFile: (filePath: string) => void;
  invalidateResolvedFileContent: (filePath: string) => void;
  markReviewFileExternallyChanged: (filePath: string, type: ReviewExternalChange['type']) => void;
  clearReviewFileExternalChange: (filePath: string) => void;
  reloadReviewFileFromDisk: (filePath: string) => void;
  invalidateChangeStats: (teamName: string) => void;

  // Editable diff actions
  updateEditedContent: (filePath: string, content: string) => void;
  discardFileEdits: (filePath: string) => void;
  discardAllEdits: () => void;
  saveEditedFile: (filePath: string, projectPath?: string) => Promise<void>;

  // Task change availability
  checkTaskHasChanges: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<void>;
  warmTaskChangeSummaries: (
    requests: { teamName: string; taskId: string; options: TaskChangeRequestOptions }[]
  ) => Promise<void>;
  invalidateTaskChangePresence: (cacheKeys: string[]) => void;
}

/**
 * Map a current CM chunk index to its original index, accounting for chunks
 * that have been accepted/rejected (removed from CM view, causing index shifts).
 *
 * When chunk 0 is accepted, CM removes it — old chunk 1 becomes new chunk 0.
 * This function reverses that shift so decisions are stored with stable indices.
 */
function mapCurrentToOriginalIndex(
  reviewKey: string,
  currentIdx: number,
  hunkDecisions: Record<string, HunkDecision>,
  totalChunks: number
): number {
  const decided = new Set<number>();
  for (let i = 0; i < totalChunks; i++) {
    if (buildHunkDecisionKey(reviewKey, i) in hunkDecisions) {
      decided.add(i);
    }
  }

  // Walk original indices, skip already-decided, count undecided until currentIdx
  let undecidedSeen = 0;
  for (let orig = 0; orig < totalChunks; orig++) {
    if (decided.has(orig)) continue;
    if (undecidedSeen === currentIdx) return orig;
    undecidedSeen++;
  }

  return currentIdx;
}

/** Get the hunk count for a file: prefer actual CM chunk count, fallback to snippet count */
export function getFileHunkCount(
  filePath: string,
  snippetsLength: number,
  fileChunkCounts: Record<string, number>
): number {
  return fileChunkCounts[filePath] ?? snippetsLength;
}

function getMaxDecisionIndexForFile(
  reviewKey: string,
  hunkDecisions: Record<string, HunkDecision>
): number {
  let max = -1;
  const prefix = `${reviewKey}:`;
  for (const key of Object.keys(hunkDecisions)) {
    if (!key.startsWith(prefix)) continue;
    const raw = key.slice(prefix.length);
    const idx = Number.parseInt(raw, 10);
    if (!Number.isNaN(idx)) {
      max = Math.max(max, idx);
    }
  }
  return max;
}

function buildHunkContextHashesForFile(
  original: string | null | undefined,
  modified: string | null | undefined,
  expectedHunkCount: number
): Record<number, string> | undefined {
  if (original === null || original === undefined) return undefined;
  if (modified === null || modified === undefined) return undefined;

  const patch = structuredPatch('file', 'file', original, modified);
  const hunks = patch.hunks ?? [];
  if (hunks.length === 0) return undefined;
  if (hunks.length !== expectedHunkCount) return undefined;

  const out: Record<number, string> = {};
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const oldSideContent = hunk.lines
      .filter((l) => !l.startsWith('+'))
      .map((l) => l.slice(1))
      .join('\n');
    const newSideContent = hunk.lines
      .filter((l) => !l.startsWith('-'))
      .map((l) => l.slice(1))
      .join('\n');
    out[i] = computeDiffContextHash(oldSideContent, newSideContent);
  }
  return out;
}

export const createChangeReviewSlice: StateCreator<AppState, [], [], ChangeReviewSlice> = (
  set,
  get
) => {
  const buildResolvedFileInvalidation = (
    s: ChangeReviewSlice,
    filePath: string
  ): Pick<
    ChangeReviewSlice,
    | 'fileChunkCounts'
    | 'fileContents'
    | 'fileContentsLoading'
    | 'hunkContextHashesByFile'
    | 'fileContentVersionByPath'
  > => {
    const nextFileChunkCounts = { ...s.fileChunkCounts };
    delete nextFileChunkCounts[filePath];

    const nextFileContents = { ...s.fileContents };
    delete nextFileContents[filePath];

    const nextFileContentsLoading = { ...s.fileContentsLoading };
    delete nextFileContentsLoading[filePath];

    const nextHunkContextHashesByFile = { ...s.hunkContextHashesByFile };
    const reviewKey = getReviewKeyForFilePath(s.activeChangeSet?.files, filePath);
    delete nextHunkContextHashesByFile[reviewKey];
    delete nextHunkContextHashesByFile[filePath];

    return {
      fileChunkCounts: nextFileChunkCounts,
      fileContents: nextFileContents,
      fileContentsLoading: nextFileContentsLoading,
      hunkContextHashesByFile: nextHunkContextHashesByFile,
      fileContentVersionByPath: {
        ...s.fileContentVersionByPath,
        [filePath]: (s.fileContentVersionByPath[filePath] ?? 0) + 1,
      },
    };
  };

  const installActiveChangeSetForLoad = (
    data: ReviewChangeSetLike,
    extraState?: Partial<ChangeReviewSlice>
  ): void => {
    set((s) => ({
      activeChangeSet: data,
      changeSetLoading: false,
      selectedReviewFilePath: data.files[0]?.filePath ?? null,
      hunkDecisions: {},
      fileDecisions: {},
      fileContents: {},
      fileContentsLoading: {},
      fileChunkCounts: {},
      reviewUndoStack: [],
      hunkContextHashesByFile: {},
      applyError: null,
      editedContents: {},
      changeSetEpoch: s.changeSetEpoch + 1,
      fileContentVersionByPath: {},
      reviewExternalChangesByFile: {},
      ...extraState,
    }));
  };

  const replaceActiveChangeSetAfterStaleRefresh = (
    fresh: ReviewChangeSetLike,
    applyError: string
  ): void => {
    set((s) => ({
      activeChangeSet: fresh,
      applying: false,
      applyError,
      selectedReviewFilePath: fresh.files[0]?.filePath ?? null,
      hunkDecisions: {},
      fileDecisions: {},
      fileChunkCounts: {},
      reviewUndoStack: [],
      hunkContextHashesByFile: {},
      fileContents: {},
      fileContentsLoading: {},
      editedContents: {},
      changeSetEpoch: s.changeSetEpoch + 1,
      fileContentVersionByPath: {},
      reviewExternalChangesByFile: {},
    }));
  };

  const revalidateTaskChangePresence = async (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ): Promise<void> => {
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
    if (
      !isTaskSummaryCacheableForOptions(options) ||
      taskChangesPresenceRevalidationInFlight.has(cacheKey)
    ) {
      return;
    }

    taskChangesPresenceRevalidationInFlight.add(cacheKey);
    try {
      const data = await api.review.getTaskChanges(teamName, taskId, {
        ...options,
        summaryOnly: true,
        forceFresh: true,
      });
      const nextPresence = resolveTaskChangePresenceFromResult(data);
      set((state) => ({
        taskChangePresenceByKey: applyTaskChangePresenceCacheUpdate(
          state.taskChangePresenceByKey,
          cacheKey,
          nextPresence
        ),
      }));
      syncTaskChangeNegativeCache(cacheKey, nextPresence);
      get().setSelectedTeamTaskChangePresence(teamName, taskId, nextPresence ?? 'unknown');
    } catch {
      // Best-effort background revalidation; keep optimistic state on transient failure.
    } finally {
      taskChangesPresenceRevalidationInFlight.delete(cacheKey);
    }
  };

  return {
    // Phase 1 initial state
    activeChangeSet: null,
    activeTaskChangeRequestOptions: null,
    changeSetLoading: false,
    changeSetError: null,
    selectedReviewFilePath: null,
    changeStatsCache: {},

    // Phase 2 initial state
    hunkDecisions: {},
    fileDecisions: {},
    fileChunkCounts: {},
    reviewUndoStack: [],
    hunkContextHashesByFile: {},
    fileContents: {},
    fileContentsLoading: {},
    changeSetEpoch: 0,
    fileContentVersionByPath: {},
    reviewExternalChangesByFile: {},
    collapseUnchanged: true,
    applyError: null,
    applying: false,

    // Editable diff initial state
    editedContents: {},

    taskChangePresenceByKey: {},

    fetchAgentChanges: async (teamName: string, memberName: string) => {
      const requestToken = ++latestAgentChangesRequestToken;
      set({ changeSetLoading: true, changeSetError: null });
      try {
        const data = await api.review.getAgentChanges(teamName, memberName);
        if (requestToken !== latestAgentChangesRequestToken) return;
        installActiveChangeSetForLoad(data, { activeTaskChangeRequestOptions: null });
      } catch (error) {
        if (requestToken !== latestAgentChangesRequestToken) return;
        const message = error instanceof Error ? error.message : 'Failed to fetch agent changes';
        logger.error('fetchAgentChanges error:', message);
        set({ changeSetError: message, changeSetLoading: false });
      }
    },

    recordTaskChangePresence: (
      teamName: string,
      taskId: string,
      options: TaskChangeRequestOptions,
      presence: TaskChangePresenceState | null
    ) => {
      const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
      set((s) => {
        return {
          taskChangePresenceByKey: applyTaskChangePresenceCacheUpdate(
            s.taskChangePresenceByKey,
            cacheKey,
            presence
          ),
        };
      });
      syncTaskChangeNegativeCache(cacheKey, presence);
    },

    fetchTaskChanges: async (
      teamName: string,
      taskId: string,
      options: TaskChangeRequestOptions
    ) => {
      const requestToken = ++latestTaskChangesRequestToken;
      set({ changeSetLoading: true, changeSetError: null });
      try {
        const data = await api.review.getTaskChanges(teamName, taskId, options);
        if (requestToken !== latestTaskChangesRequestToken) return;
        const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
        const nextPresence = resolveTaskChangePresenceFromResult(data);
        installActiveChangeSetForLoad(data, {
          activeTaskChangeRequestOptions: options,
          taskChangePresenceByKey: applyTaskChangePresenceCacheUpdate(
            get().taskChangePresenceByKey,
            cacheKey,
            nextPresence
          ),
        });
        get().setSelectedTeamTaskChangePresence(teamName, taskId, nextPresence ?? 'unknown');
        syncTaskChangeNegativeCache(cacheKey, nextPresence);
      } catch (error) {
        if (requestToken !== latestTaskChangesRequestToken) return;
        const message = error instanceof Error ? error.message : 'Failed to fetch task changes';
        logger.error('fetchTaskChanges error:', message);
        set({ changeSetError: message, changeSetLoading: false });
      }
    },

    selectReviewFile: (filePath: string | null) => {
      set({ selectedReviewFilePath: filePath });
    },

    clearChangeReview: () => {
      latestAgentChangesRequestToken++;
      latestTaskChangesRequestToken++;
      latestDecisionLoadRequestToken++;
      clearAllPersistDecisionTimers();
      set((s) => ({
        activeChangeSet: null,
        changeSetLoading: false,
        changeSetError: null,
        selectedReviewFilePath: null,
        activeTaskChangeRequestOptions: null,
        hunkDecisions: {},
        fileDecisions: {},
        fileChunkCounts: {},
        reviewUndoStack: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        editedContents: {},
      }));
    },

    clearChangeReviewCache: () => {
      latestAgentChangesRequestToken++;
      latestTaskChangesRequestToken++;
      latestDecisionLoadRequestToken++;
      clearAllPersistDecisionTimers();
      set((s) => ({
        activeChangeSet: null,
        changeSetLoading: false,
        changeSetError: null,
        selectedReviewFilePath: null,
        activeTaskChangeRequestOptions: null,
        hunkDecisions: {},
        fileDecisions: {},
        fileChunkCounts: {},
        reviewUndoStack: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        editedContents: {},
      }));
    },

    resetAllReviewState: () => {
      latestAgentChangesRequestToken++;
      latestTaskChangesRequestToken++;
      latestDecisionLoadRequestToken++;
      clearAllPersistDecisionTimers();
      set((s) => ({
        activeChangeSet: null,
        changeSetLoading: false,
        changeSetError: null,
        selectedReviewFilePath: null,
        activeTaskChangeRequestOptions: null,
        hunkDecisions: {},
        fileDecisions: {},
        fileChunkCounts: {},
        reviewUndoStack: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        editedContents: {},
      }));
    },

    // ── Decision persistence ──

    loadDecisionsFromDisk: async (teamName: string, scopeKey: string, scopeToken: string) => {
      const requestToken = ++latestDecisionLoadRequestToken;
      try {
        const data = await api.review.loadDecisions(teamName, scopeKey, scopeToken);
        if (requestToken !== latestDecisionLoadRequestToken) return;
        const normalized = normalizePersistedReviewState(get().activeChangeSet?.files ?? [], {
          hunkDecisions: data?.hunkDecisions,
          fileDecisions: data?.fileDecisions,
          hunkContextHashesByFile: data?.hunkContextHashesByFile,
        });
        // Always set decisions — even to empty if no saved file exists.
        // This prevents stale decisions from a previous scope leaking through.
        set({
          hunkDecisions: normalized.hunkDecisions,
          fileDecisions: normalized.fileDecisions,
          hunkContextHashesByFile: normalized.hunkContextHashesByFile,
        });
      } catch (error) {
        if (requestToken !== latestDecisionLoadRequestToken) return;
        logger.error('loadDecisionsFromDisk error:', error);
        set({
          hunkDecisions: {},
          fileDecisions: {},
          hunkContextHashesByFile: {},
        });
      }
    },

    persistDecisions: (teamName: string, scopeKey: string, scopeToken: string) => {
      const scopeStorageKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      clearPersistDecisionTimer(scopeStorageKey);

      const {
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile,
        activeChangeSet,
        fileContents,
        fileChunkCounts,
      } = get();

      const computed: Record<string, Record<number, string>> = {};
      for (const file of activeChangeSet?.files ?? []) {
        const fp = file.filePath;
        const content = fileContents[fp];
        if (!content) continue;
        const expected = getFileHunkCount(fp, file.snippets.length, fileChunkCounts);
        const hashes = buildHunkContextHashesForFile(
          content.originalFullContent,
          content.modifiedFullContent,
          expected
        );
        if (hashes) computed[fp] = hashes;
      }

      const mergedHashes: Record<string, Record<number, string>> = {};
      for (const file of activeChangeSet?.files ?? []) {
        const fp = file.filePath;
        const reviewKey = getFileReviewKey(file);
        mergedHashes[reviewKey] =
          computed[fp] ?? hunkContextHashesByFile[reviewKey] ?? hunkContextHashesByFile[fp] ?? {};
      }
      set({ hunkContextHashesByFile: mergedHashes });

      const persistedHunkDecisions = { ...hunkDecisions };
      const persistedFileDecisions = { ...fileDecisions };
      const persistedHashes = { ...mergedHashes };

      const timer = setTimeout(() => {
        persistDebounceTimers.delete(scopeStorageKey);
        void api.review.saveDecisions(
          teamName,
          scopeKey,
          scopeToken,
          persistedHunkDecisions,
          persistedFileDecisions,
          persistedHashes
        );
      }, PERSIST_DEBOUNCE_MS);

      persistDebounceTimers.set(scopeStorageKey, timer);
    },

    clearDecisionsFromDisk: async (teamName: string, scopeKey: string, scopeToken?: string) => {
      clearPersistDecisionTimer(buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken));
      try {
        await api.review.clearDecisions(teamName, scopeKey, scopeToken);
      } catch (error) {
        logger.error('clearDecisionsFromDisk error:', error);
      }
    },

    fetchChangeStats: async (teamName: string, memberName: string) => {
      try {
        const stats = await api.review.getChangeStats(teamName, memberName);
        const key = `${teamName}:${memberName}`;
        set((state) => ({
          changeStatsCache: { ...state.changeStatsCache, [key]: stats },
        }));
      } catch (error) {
        logger.error('fetchChangeStats error:', error);
      }
    },

    // ── Phase 2 actions ──

    setHunkDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => {
      const state = get();
      const totalChunks = state.fileChunkCounts[filePath] ?? 0;
      const reviewKey = getReviewKeyForFilePath(state.activeChangeSet?.files, filePath);
      // Map current chunk index to original: after accept/reject, chunks shift in CM.
      // We need the original index to keep decisions stable across shifts.
      const originalIndex =
        totalChunks > 0
          ? mapCurrentToOriginalIndex(reviewKey, hunkIndex, state.hunkDecisions, totalChunks)
          : hunkIndex;
      const key = buildHunkDecisionKey(reviewKey, originalIndex);
      set((s) => ({
        hunkDecisions: { ...s.hunkDecisions, [key]: decision },
      }));
      return originalIndex;
    },

    clearHunkDecisionByOriginalIndex: (filePath: string, originalIndex: number) => {
      const key = buildHunkDecisionKey(
        getReviewKeyForFilePath(get().activeChangeSet?.files, filePath),
        originalIndex
      );
      set((s) => {
        if (!(key in s.hunkDecisions)) return s;
        const next = { ...s.hunkDecisions };
        delete next[key];
        return { hunkDecisions: next };
      });
    },

    setFileDecision: (filePath: string, decision: HunkDecision) => {
      const reviewKey = getReviewKeyForFilePath(get().activeChangeSet?.files, filePath);
      set((state) => ({
        fileDecisions: { ...state.fileDecisions, [reviewKey]: decision },
      }));
    },

    setFileChunkCount: (filePath: string, count: number) => {
      set((s) => ({
        fileChunkCounts: { ...s.fileChunkCounts, [filePath]: count },
      }));
    },

    pushReviewUndoSnapshot: () => {
      const state = get();
      const snapshot: DecisionSnapshot = {
        hunkDecisions: { ...state.hunkDecisions },
        fileDecisions: { ...state.fileDecisions },
      };
      const stack = [...state.reviewUndoStack, snapshot];
      if (stack.length > MAX_REVIEW_UNDO_DEPTH) {
        stack.shift();
      }
      set({ reviewUndoStack: stack });
    },

    undoBulkReview: () => {
      const state = get();
      if (state.reviewUndoStack.length === 0) return false;
      const stack = [...state.reviewUndoStack];
      const snapshot = stack.pop()!;
      set({
        hunkDecisions: snapshot.hunkDecisions,
        fileDecisions: snapshot.fileDecisions,
        reviewUndoStack: stack,
      });
      return true;
    },

    acceptAllFile: (filePath: string) => {
      const state = get();
      const file = findReviewFileByPath(state.activeChangeSet?.files, filePath);
      if (!file) return;

      const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
      const newHunkDecisions = { ...state.hunkDecisions };
      const reviewKey = getFileReviewKey(file);
      for (let i = 0; i < count; i++) {
        newHunkDecisions[buildHunkDecisionKey(reviewKey, i)] = 'accepted';
      }
      set({
        hunkDecisions: newHunkDecisions,
        fileDecisions: { ...state.fileDecisions, [reviewKey]: 'accepted' },
      });
    },

    rejectAllFile: (filePath: string) => {
      const state = get();
      const file = findReviewFileByPath(state.activeChangeSet?.files, filePath);
      if (!file) return;

      const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
      const newHunkDecisions = { ...state.hunkDecisions };
      const reviewKey = getFileReviewKey(file);
      for (let i = 0; i < count; i++) {
        newHunkDecisions[buildHunkDecisionKey(reviewKey, i)] = 'rejected';
      }
      set({
        hunkDecisions: newHunkDecisions,
        fileDecisions: { ...state.fileDecisions, [reviewKey]: 'rejected' },
      });
    },

    acceptAll: () => {
      const state = get();
      if (!state.activeChangeSet) return;

      const newHunkDecisions: Record<string, HunkDecision> = {};
      const newFileDecisions: Record<string, HunkDecision> = {};

      for (const file of state.activeChangeSet.files) {
        const reviewKey = getFileReviewKey(file);
        newFileDecisions[reviewKey] = 'accepted';
        const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
        for (let i = 0; i < count; i++) {
          newHunkDecisions[buildHunkDecisionKey(reviewKey, i)] = 'accepted';
        }
      }
      set({ hunkDecisions: newHunkDecisions, fileDecisions: newFileDecisions });
    },

    rejectAll: () => {
      const state = get();
      if (!state.activeChangeSet) return;

      const newHunkDecisions: Record<string, HunkDecision> = {};
      const newFileDecisions: Record<string, HunkDecision> = {};

      for (const file of state.activeChangeSet.files) {
        const reviewKey = getFileReviewKey(file);
        newFileDecisions[reviewKey] = 'rejected';
        const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
        for (let i = 0; i < count; i++) {
          newHunkDecisions[buildHunkDecisionKey(reviewKey, i)] = 'rejected';
        }
      }
      set({ hunkDecisions: newHunkDecisions, fileDecisions: newFileDecisions });
    },

    setCollapseUnchanged: (collapse: boolean) => {
      set({ collapseUnchanged: collapse });
    },

    fetchFileContent: async (
      teamName: string,
      memberName: string | undefined,
      filePath: string
    ) => {
      const state = get();
      // Skip if already loaded or loading
      if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;
      const changeSetEpoch = state.changeSetEpoch;
      const fileVersion = state.fileContentVersionByPath[filePath] ?? 0;

      set((s) => ({
        fileContentsLoading: { ...s.fileContentsLoading, [filePath]: true },
      }));

      try {
        // Lookup snippets from activeChangeSet so backend can use them for reconstruction
        const activeChangeSet = get().activeChangeSet;
        const fileEntry = findReviewFileByPath(activeChangeSet?.files, filePath);
        const canonicalFilePath = fileEntry?.filePath ?? filePath;
        const snippets = fileEntry?.snippets ?? [];

        const content = await api.review.getFileContent(teamName, memberName, canonicalFilePath, snippets);
        const latest = get();
        if (changeSetEpoch !== latest.changeSetEpoch) return;
        if ((latest.fileContentVersionByPath[filePath] ?? 0) !== fileVersion) return;
        set((s) => {
          const result: Partial<ChangeReviewSlice> = {
            fileContents: { ...s.fileContents, [filePath]: content },
            fileContentsLoading: { ...s.fileContentsLoading, [filePath]: false },
          };

          // Update activeChangeSet stats if original was successfully resolved
          if (
            content.contentSource !== 'unavailable' &&
            content.contentSource !== 'disk-current' &&
            s.activeChangeSet
          ) {
            const updatedFiles = s.activeChangeSet.files.map((f) =>
              reviewPathsEqual(f.filePath, canonicalFilePath)
                ? { ...f, linesAdded: content.linesAdded, linesRemoved: content.linesRemoved }
                : f
            );
            const totalLinesAdded = updatedFiles.reduce((sum, f) => sum + f.linesAdded, 0);
            const totalLinesRemoved = updatedFiles.reduce((sum, f) => sum + f.linesRemoved, 0);
            result.activeChangeSet = {
              ...s.activeChangeSet,
              files: updatedFiles,
              totalLinesAdded,
              totalLinesRemoved,
            };
          }

          return result;
        });
      } catch (error) {
        const latest = get();
        if (changeSetEpoch !== latest.changeSetEpoch) return;
        if ((latest.fileContentVersionByPath[filePath] ?? 0) !== fileVersion) return;
        logger.error('fetchFileContent error:', error);
        set((s) => ({
          fileContentsLoading: { ...s.fileContentsLoading, [filePath]: false },
        }));
      }
    },

    applyReview: async (teamName: string, taskId?: string, memberName?: string) => {
      set({ applying: true, applyError: null });

      try {
        // Stale check: re-fetch changes and compare content fingerprint
        const state = get();
        const current = state.activeChangeSet;
        const currentFingerprint = getReviewChangeSetIdentityToken(current);
        const staleMessage =
          'Changes have been updated since you started reviewing. Please re-review.';

        if (memberName && current) {
          const fresh = await api.review.getAgentChanges(teamName, memberName);
          if (currentFingerprint !== getReviewChangeSetIdentityToken(fresh)) {
            replaceActiveChangeSetAfterStaleRefresh(fresh, staleMessage);
            return;
          }
        } else if (taskId && current) {
          const fresh = await api.review.getTaskChanges(teamName, taskId, {
            ...(state.activeTaskChangeRequestOptions ?? {}),
            forceFresh: true,
          });
          if (currentFingerprint !== getReviewChangeSetIdentityToken(fresh)) {
            replaceActiveChangeSetAfterStaleRefresh(fresh, staleMessage);
            return;
          }
        }

        // Build FileReviewDecision[] from hunkDecisions/fileDecisions
        const { hunkDecisions, fileDecisions, fileChunkCounts, activeChangeSet, fileContents } =
          get();
        if (!activeChangeSet) {
          set({ applying: false });
          return;
        }

        const decisions: FileReviewDecision[] = [];

        for (const file of activeChangeSet.files) {
          const reviewKey = getFileReviewKey(file);
          const fileDecision = fileDecisions[reviewKey] ?? 'pending';
          const hunkDecs: Record<number, HunkDecision> = {};

          const baseCount = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
          const maxIdx = getMaxDecisionIndexForFile(reviewKey, hunkDecisions);
          const count = Math.max(baseCount, maxIdx + 1);
          for (let i = 0; i < count; i++) {
            const key = buildHunkDecisionKey(reviewKey, i);
            hunkDecs[i] = hunkDecisions[key] ?? 'pending';
          }

          // Only include files that have at least one rejected hunk
          const hasRejected =
            fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
          if (hasRejected) {
            const content = fileContents[file.filePath];
            const hunkContextHashes =
              maxIdx < baseCount
                ? buildHunkContextHashesForFile(
                    content?.originalFullContent,
                    content?.modifiedFullContent,
                    baseCount
                  )
                : undefined;
            decisions.push({
              filePath: file.filePath,
              fileDecision,
              hunkDecisions: hunkDecs,
              hunkContextHashes,
              // Provide optional context so main can apply without re-resolving.
              // If full contents are missing (lazy not loaded yet), still pass snippets.
              snippets: content?.snippets ?? file.snippets,
              originalFullContent: content?.originalFullContent,
              modifiedFullContent: content?.modifiedFullContent,
              isNewFile: content?.isNewFile ?? file.isNewFile,
            });
          }
        }

        if (decisions.length === 0) {
          set({ applying: false });
          return;
        }

        const request: ApplyReviewRequest = {
          teamName,
          taskId,
          memberName,
          decisions,
        };

        await api.review.applyDecisions(request);

        set({ applying: false });
      } catch (error) {
        logger.error('applyReview error:', error);
        set({
          applying: false,
          applyError: mapReviewError(error),
        });
      }
    },

    applySingleFileDecision: async (
      teamName: string,
      filePath: string,
      taskId?: string,
      memberName?: string
    ) => {
      const { hunkDecisions, fileDecisions, fileChunkCounts, activeChangeSet, fileContents } =
        get();
      if (!activeChangeSet) return null;

      const file = findReviewFileByPath(activeChangeSet.files, filePath);
      if (!file) return null;

      const reviewKey = getFileReviewKey(file);
      const fileDecision = fileDecisions[reviewKey] ?? 'pending';
      const hunkDecs: Record<number, HunkDecision> = {};
      const baseCount = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
      const maxIdx = getMaxDecisionIndexForFile(reviewKey, hunkDecisions);
      const count = Math.max(baseCount, maxIdx + 1);
      for (let i = 0; i < count; i++) {
        hunkDecs[i] = hunkDecisions[buildHunkDecisionKey(reviewKey, i)] ?? 'pending';
      }

      const hasRejected =
        fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
      if (!hasRejected) return null;

      try {
        const content = fileContents[file.filePath] ?? fileContents[filePath];
        const innerBaseCount = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
        const innerMaxIdx = getMaxDecisionIndexForFile(reviewKey, hunkDecisions);
        const hunkContextHashes =
          innerMaxIdx < innerBaseCount
            ? buildHunkContextHashesForFile(
                content?.originalFullContent,
                content?.modifiedFullContent,
                innerBaseCount
              )
            : undefined;
        const result = await api.review.applyDecisions({
          teamName,
          taskId,
          memberName,
          decisions: [
            {
              filePath: file.filePath,
              fileDecision,
              hunkDecisions: hunkDecs,
              hunkContextHashes,
              snippets: content?.snippets ?? file.snippets,
              originalFullContent: content?.originalFullContent,
              modifiedFullContent: content?.modifiedFullContent,
              isNewFile: content?.isNewFile ?? file.isNewFile,
            },
          ],
        });
        return result;
      } catch (error) {
        logger.error('applySingleFileDecision error:', error);
        set({ applyError: mapReviewError(error) });
        return null;
      }
    },

    removeReviewFile: (filePath: string) => {
      set((s) => {
        if (!s.activeChangeSet) return s;
        const existing = findReviewFileByPath(s.activeChangeSet.files, filePath);
        if (!existing) return s;

        const nextFiles = s.activeChangeSet.files.filter(
          (f) => !reviewPathsEqual(f.filePath, existing.filePath)
        );
        const totalLinesAdded = nextFiles.reduce((sum, f) => sum + f.linesAdded, 0);
        const totalLinesRemoved = nextFiles.reduce((sum, f) => sum + f.linesRemoved, 0);

        const nextHunkDecisions = { ...s.hunkDecisions };
        const reviewKey = getReviewKeyForFilePath(s.activeChangeSet.files, filePath);
        const prefix = `${reviewKey}:`;
        for (const key of Object.keys(nextHunkDecisions)) {
          if (key.startsWith(prefix)) delete nextHunkDecisions[key];
        }

        const nextFileDecisions = { ...s.fileDecisions };
        delete nextFileDecisions[reviewKey];

        const nextFileChunkCounts = { ...s.fileChunkCounts };
        delete nextFileChunkCounts[filePath];
        delete nextFileChunkCounts[existing.filePath];

        const nextFileContents = { ...s.fileContents };
        delete nextFileContents[filePath];
        delete nextFileContents[existing.filePath];

        const nextFileContentsLoading = { ...s.fileContentsLoading };
        delete nextFileContentsLoading[filePath];
        delete nextFileContentsLoading[existing.filePath];

        const nextEditedContents = { ...s.editedContents };
        delete nextEditedContents[filePath];
        delete nextEditedContents[existing.filePath];

        const nextHashes = { ...s.hunkContextHashesByFile };
        delete nextHashes[reviewKey];
        delete nextHashes[filePath];

        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        delete nextReviewExternalChangesByFile[filePath];
        delete nextReviewExternalChangesByFile[existing.filePath];

        const nextFileContentVersionByPath = {
          ...s.fileContentVersionByPath,
          [filePath]: (s.fileContentVersionByPath[filePath] ?? 0) + 1,
          [existing.filePath]: (s.fileContentVersionByPath[existing.filePath] ?? 0) + 1,
        };

        const nextSelected =
          s.selectedReviewFilePath && reviewPathsEqual(s.selectedReviewFilePath, existing.filePath)
            ? (nextFiles[0]?.filePath ?? null)
            : s.selectedReviewFilePath;

        return {
          activeChangeSet: {
            ...s.activeChangeSet,
            files: nextFiles,
            totalFiles: nextFiles.length,
            totalLinesAdded,
            totalLinesRemoved,
          },
          selectedReviewFilePath: nextSelected,
          hunkDecisions: nextHunkDecisions,
          fileDecisions: nextFileDecisions,
          fileChunkCounts: nextFileChunkCounts,
          fileContents: nextFileContents,
          fileContentsLoading: nextFileContentsLoading,
          editedContents: nextEditedContents,
          hunkContextHashesByFile: nextHashes,
          fileContentVersionByPath: nextFileContentVersionByPath,
          reviewExternalChangesByFile: nextReviewExternalChangesByFile,
        };
      });
    },

    addReviewFile: (
      file: FileChangeSummary,
      options?: { index?: number; content?: FileChangeWithContent }
    ) => {
      set((s) => {
        if (!s.activeChangeSet) return s;
        if (findReviewFileByPath(s.activeChangeSet.files, file.filePath)) return s;

        const idxRaw = options?.index;
        const idx =
          typeof idxRaw === 'number' && Number.isFinite(idxRaw)
            ? Math.max(0, Math.min(idxRaw, s.activeChangeSet.files.length))
            : s.activeChangeSet.files.length;

        const nextFiles = [...s.activeChangeSet.files];
        nextFiles.splice(idx, 0, file);
        const totalLinesAdded = nextFiles.reduce((sum, f) => sum + f.linesAdded, 0);
        const totalLinesRemoved = nextFiles.reduce((sum, f) => sum + f.linesRemoved, 0);

        const nextFileContents = options?.content
          ? { ...s.fileContents, [file.filePath]: options.content }
          : s.fileContents;

        const nextFileContentsLoading = options?.content
          ? { ...s.fileContentsLoading, [file.filePath]: false }
          : s.fileContentsLoading;

        const nextFileContentVersionByPath = {
          ...s.fileContentVersionByPath,
          [file.filePath]: s.fileContentVersionByPath[file.filePath] ?? 0,
        };

        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        delete nextReviewExternalChangesByFile[file.filePath];

        return {
          activeChangeSet: {
            ...s.activeChangeSet,
            files: nextFiles,
            totalFiles: nextFiles.length,
            totalLinesAdded,
            totalLinesRemoved,
          },
          selectedReviewFilePath: s.selectedReviewFilePath ?? file.filePath,
          fileContents: nextFileContents,
          fileContentsLoading: nextFileContentsLoading,
          fileContentVersionByPath: nextFileContentVersionByPath,
          reviewExternalChangesByFile: nextReviewExternalChangesByFile,
        };
      });
    },

    clearReviewStateForFile: (filePath: string) => {
      set((s) => {
        const nextHunkDecisions = { ...s.hunkDecisions };
        const reviewKey = getReviewKeyForFilePath(s.activeChangeSet?.files, filePath);
        const prefix = `${reviewKey}:`;
        for (const key of Object.keys(nextHunkDecisions)) {
          if (key.startsWith(prefix) && nextHunkDecisions[key] === 'rejected') {
            delete nextHunkDecisions[key];
          }
        }

        const nextFileDecisions = { ...s.fileDecisions };
        if (nextFileDecisions[reviewKey] === 'rejected') {
          delete nextFileDecisions[reviewKey];
        }

        const nextEditedContents = { ...s.editedContents };
        delete nextEditedContents[filePath];
        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        delete nextReviewExternalChangesByFile[filePath];

        return {
          hunkDecisions: nextHunkDecisions,
          fileDecisions: nextFileDecisions,
          editedContents: nextEditedContents,
          reviewExternalChangesByFile: nextReviewExternalChangesByFile,
          ...buildResolvedFileInvalidation(s, filePath),
        };
      });
    },

    invalidateResolvedFileContent: (filePath: string) => {
      set((s) => buildResolvedFileInvalidation(s, filePath));
    },

    markReviewFileExternallyChanged: (filePath: string, type: ReviewExternalChange['type']) => {
      set((s) => ({
        reviewExternalChangesByFile: {
          ...s.reviewExternalChangesByFile,
          [filePath]: { type },
        },
      }));
    },

    clearReviewFileExternalChange: (filePath: string) => {
      set((s) => {
        if (!(filePath in s.reviewExternalChangesByFile)) return s;
        const next = { ...s.reviewExternalChangesByFile };
        delete next[filePath];
        return { reviewExternalChangesByFile: next };
      });
    },

    reloadReviewFileFromDisk: (filePath: string) => {
      set((s) => {
        const nextEditedContents = { ...s.editedContents };
        delete nextEditedContents[filePath];
        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        delete nextReviewExternalChangesByFile[filePath];
        return {
          editedContents: nextEditedContents,
          reviewExternalChangesByFile: nextReviewExternalChangesByFile,
          ...buildResolvedFileInvalidation(s, filePath),
        };
      });
    },

    // ── Editable diff actions ──

    updateEditedContent: (filePath: string, content: string) => {
      set((s) => ({
        editedContents: { ...s.editedContents, [filePath]: content },
      }));
    },

    discardFileEdits: (filePath: string) => {
      set((s) => {
        const next = { ...s.editedContents };
        delete next[filePath];
        return { editedContents: next };
      });
    },

    discardAllEdits: () => set({ editedContents: {} }),

    saveEditedFile: async (filePath: string, projectPath?: string) => {
      const content = get().editedContents[filePath];
      if (!(filePath in get().editedContents)) return;
      set((s) => ({
        fileContentsLoading: { ...s.fileContentsLoading, [filePath]: false },
        applying: true,
        applyError: null,
        fileContentVersionByPath: {
          ...s.fileContentVersionByPath,
          [filePath]: (s.fileContentVersionByPath[filePath] ?? 0) + 1,
        },
      }));
      try {
        await api.review.saveEditedFile(filePath, content, projectPath);
        set((s) => {
          const nextEdited = { ...s.editedContents };
          delete nextEdited[filePath];

          const nextFileChunkCounts = { ...s.fileChunkCounts };
          delete nextFileChunkCounts[filePath];

          const nextHunkContextHashesByFile = { ...s.hunkContextHashesByFile };
          const reviewKey = getReviewKeyForFilePath(s.activeChangeSet?.files, filePath);
          delete nextHunkContextHashesByFile[reviewKey];
          delete nextHunkContextHashesByFile[filePath];

          const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
          delete nextReviewExternalChangesByFile[filePath];

          // Update cached content in-place to avoid skeleton flash.
          // Replace modifiedFullContent with saved version so CodeMirror
          // reflects the new baseline without a full re-fetch cycle.
          const nextContents = { ...s.fileContents };
          const existing = nextContents[filePath];
          if (existing) {
            nextContents[filePath] = {
              ...existing,
              modifiedFullContent: content,
              contentSource: 'disk-current',
            };
          }
          return {
            editedContents: nextEdited,
            fileChunkCounts: nextFileChunkCounts,
            hunkContextHashesByFile: nextHunkContextHashesByFile,
            fileContents: nextContents,
            reviewExternalChangesByFile: nextReviewExternalChangesByFile,
            applying: false,
          };
        });
      } catch (error) {
        set({ applying: false, applyError: mapReviewError(error) });
      }
    },

    checkTaskHasChanges: async (
      teamName: string,
      taskId: string,
      options: TaskChangeRequestOptions
    ) => {
      const selectedTask =
        get().selectedTeamName === teamName
          ? get().selectedTeamData?.tasks.find((task) => task.id === taskId)
          : undefined;
      const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
      const summaryCacheable = isTaskSummaryCacheableForOptions(options);
      const cachedPresence = get().taskChangePresenceByKey[cacheKey];
      if (
        summaryCacheable &&
        (cachedPresence === 'has_changes' || cachedPresence === 'needs_attention')
      ) {
        get().setSelectedTeamTaskChangePresence(teamName, taskId, cachedPresence);
        return;
      }
      if (taskChangesCheckInFlight.has(cacheKey)) return;
      const negativeTs = taskChangesNegativeCache.get(cacheKey);
      const hasUnknownPresence = selectedTask?.changePresence === 'unknown';
      if (negativeTs && Date.now() - negativeTs < NEGATIVE_CACHE_TTL && !hasUnknownPresence) return;

      taskChangesCheckInFlight.add(cacheKey);
      try {
        const data = await api.review.getTaskChanges(teamName, taskId, {
          ...options,
          summaryOnly: true,
        });
        const nextPresence = resolveTaskChangePresenceFromResult(data);
        if (nextPresence === 'has_changes' || nextPresence === 'needs_attention') {
          set((s) => ({
            taskChangePresenceByKey: { ...s.taskChangePresenceByKey, [cacheKey]: nextPresence },
          }));
          taskChangesNegativeCache.delete(cacheKey);
          get().setSelectedTeamTaskChangePresence(teamName, taskId, nextPresence);
          if (shouldBackgroundRevalidateTaskPresence(data, CHANGE_REVIEW_SLICE_BOOT_TIME)) {
            void revalidateTaskChangePresence(teamName, taskId, options);
          }
        } else if (nextPresence === 'no_changes') {
          set((s) => ({
            taskChangePresenceByKey: { ...s.taskChangePresenceByKey, [cacheKey]: 'no_changes' },
          }));
          taskChangesNegativeCache.set(cacheKey, Date.now());
          get().setSelectedTeamTaskChangePresence(teamName, taskId, 'no_changes');
        } else {
          set((s) => {
            const nextTaskChangePresenceByKey = { ...s.taskChangePresenceByKey };
            delete nextTaskChangePresenceByKey[cacheKey];
            return { taskChangePresenceByKey: nextTaskChangePresenceByKey };
          });
          taskChangesNegativeCache.delete(cacheKey);
          if (selectedTask?.changePresence && selectedTask.changePresence !== 'unknown') {
            get().setSelectedTeamTaskChangePresence(teamName, taskId, 'unknown');
          }
        }
      } catch {
        // Allow immediate retry after transient failures (race, file lock, late logs).
      } finally {
        taskChangesCheckInFlight.delete(cacheKey);
      }
    },

    warmTaskChangeSummaries: async (requests) => {
      const uniqueRequests = new Map<
        string,
        { teamName: string; taskId: string; options: TaskChangeRequestOptions }
      >();
      for (const request of requests) {
        if (!isTaskSummaryCacheableForOptions(request.options)) continue;
        const cacheKey = buildTaskChangePresenceKey(
          request.teamName,
          request.taskId,
          request.options
        );
        uniqueRequests.set(cacheKey, request);
      }

      const entries = [...uniqueRequests.entries()];
      const runWarmRequest = async (
        cacheKey: string,
        request: { teamName: string; taskId: string; options: TaskChangeRequestOptions }
      ): Promise<void> => {
        const cachedPresence = get().taskChangePresenceByKey[cacheKey];
        if (
          cachedPresence === 'has_changes' ||
          cachedPresence === 'needs_attention' ||
          taskChangesCheckInFlight.has(cacheKey)
        ) {
          return;
        }

        taskChangesCheckInFlight.add(cacheKey);
        try {
          const data = await api.review.getTaskChanges(request.teamName, request.taskId, {
            ...request.options,
            summaryOnly: true,
          });
          const nextPresence = resolveTaskChangePresenceFromResult(data);
          if (nextPresence) {
            set((s) => ({
              taskChangePresenceByKey: {
                ...s.taskChangePresenceByKey,
                [cacheKey]: nextPresence,
              },
            }));
          }
          if (nextPresence === 'has_changes' || nextPresence === 'needs_attention') {
            taskChangesNegativeCache.delete(cacheKey);
            if (shouldBackgroundRevalidateTaskPresence(data, CHANGE_REVIEW_SLICE_BOOT_TIME)) {
              void revalidateTaskChangePresence(request.teamName, request.taskId, request.options);
            }
          } else if (nextPresence === 'no_changes') {
            taskChangesNegativeCache.set(cacheKey, Date.now());
          } else {
            taskChangesNegativeCache.delete(cacheKey);
          }
        } catch {
          // Best-effort warm path.
        } finally {
          taskChangesCheckInFlight.delete(cacheKey);
        }
      };

      for (let index = 0; index < entries.length; index += TASK_CHANGE_WARM_CONCURRENCY) {
        await Promise.all(
          entries
            .slice(index, index + TASK_CHANGE_WARM_CONCURRENCY)
            .map(([cacheKey, request]) => runWarmRequest(cacheKey, request))
        );
      }
    },

    invalidateTaskChangePresence: (cacheKeys) => {
      if (cacheKeys.length === 0) return;
      const keySet = new Set(cacheKeys);
      set((state) => {
        const nextTaskChangePresenceByKey = { ...state.taskChangePresenceByKey };
        let changed = false;
        for (const key of keySet) {
          if (key in nextTaskChangePresenceByKey) {
            delete nextTaskChangePresenceByKey[key];
            changed = true;
          }
          taskChangesNegativeCache.delete(key);
        }
        return changed ? { taskChangePresenceByKey: nextTaskChangePresenceByKey } : {};
      });
    },

    invalidateChangeStats: (teamName: string) => {
      set((state) => {
        const newCache = { ...state.changeStatsCache };
        // Remove all entries for this team
        for (const key of Object.keys(newCache)) {
          if (key.startsWith(`${teamName}:`)) {
            delete newCache[key];
          }
        }
        return { changeStatsCache: newCache };
      });
    },
  };
};
