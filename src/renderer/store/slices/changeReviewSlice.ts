import { api } from '@renderer/api';
import {
  buildTaskChangePresenceKey,
  isTaskSummaryCacheableForOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
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
let latestTaskChangesRequestToken = 0;

/** Debounce timer for persisting decisions to disk */
let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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
} from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('changeReviewSlice');

/** Snapshot of review decisions for undo support */
interface DecisionSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export interface ReviewExternalChange {
  type: 'change' | 'add' | 'unlink';
}

type ReviewChangeSet = AgentChangeSet | TaskChangeSet | TaskChangeSetV2;

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

function wasRestoredBeforeCurrentSession(data: TaskChangeSetV2): boolean {
  const computedAtMs = Date.parse(data.computedAt);
  if (!Number.isFinite(computedAtMs)) {
    return true;
  }
  return computedAtMs < CHANGE_REVIEW_SLICE_BOOT_TIME;
}

function resolveTaskChangePresenceFromResult(
  data: Pick<TaskChangeSetV2, 'files' | 'confidence'>
): 'has_changes' | 'no_changes' | null {
  if (data.files.length > 0) {
    return 'has_changes';
  }

  return data.confidence === 'high' || data.confidence === 'medium' ? 'no_changes' : null;
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

  /** Cache: "teamName:taskId:signature" → true/false (has file changes) */
  taskHasChanges: Record<string, boolean>;

  // Phase 1 actions
  fetchAgentChanges: (teamName: string, memberName: string) => Promise<void>;
  fetchTaskChanges: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<void>;
  recordTaskHasChanges: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions,
    hasChanges: boolean
  ) => void;
  selectReviewFile: (filePath: string | null) => void;
  clearChangeReview: () => void;
  clearChangeReviewCache: () => void;
  resetAllReviewState: () => void;
  fetchChangeStats: (teamName: string, memberName: string) => Promise<void>;

  // Decision persistence actions
  loadDecisionsFromDisk: (teamName: string, scopeKey: string) => Promise<void>;
  persistDecisions: (teamName: string, scopeKey: string) => void;
  clearDecisionsFromDisk: (teamName: string, scopeKey: string) => Promise<void>;

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
  filePath: string,
  currentIdx: number,
  hunkDecisions: Record<string, HunkDecision>,
  totalChunks: number
): number {
  const decided = new Set<number>();
  for (let i = 0; i < totalChunks; i++) {
    if (`${filePath}:${i}` in hunkDecisions) {
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
  filePath: string,
  hunkDecisions: Record<string, HunkDecision>
): number {
  let max = -1;
  const prefix = `${filePath}:`;
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

function encodeFingerprintField(value: string): string {
  return `${value.length}:${value}`;
}

function fingerprintSnippet(snippet: SnippetDiff): string {
  return [
    encodeFingerprintField(normalizePathForComparison(snippet.filePath)),
    encodeFingerprintField(snippet.toolUseId),
    encodeFingerprintField(snippet.timestamp),
    encodeFingerprintField(snippet.type),
    encodeFingerprintField(snippet.oldString),
    encodeFingerprintField(snippet.newString),
    encodeFingerprintField(snippet.replaceAll ? '1' : '0'),
    encodeFingerprintField(snippet.isError ? '1' : '0'),
    encodeFingerprintField(snippet.contextHash ?? ''),
  ].join('|');
}

function fingerprintChangeSet(changeSet: ReviewChangeSet): string {
  return [...changeSet.files]
    .sort((a, b) =>
      normalizePathForComparison(a.filePath).localeCompare(normalizePathForComparison(b.filePath))
    )
    .map((file) =>
      [
        encodeFingerprintField(normalizePathForComparison(file.filePath)),
        ...file.snippets.map(fingerprintSnippet),
      ].join('|')
    )
    .join('||');
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
    data: ReviewChangeSet,
    extraState?: Partial<ChangeReviewSlice>
  ): void => {
    set((s) => ({
      activeChangeSet: data,
      changeSetLoading: false,
      selectedReviewFilePath: data.files[0]?.filePath ?? null,
      fileContents: {},
      fileContentsLoading: {},
      fileChunkCounts: {},
      hunkContextHashesByFile: {},
      applyError: null,
      changeSetEpoch: s.changeSetEpoch + 1,
      fileContentVersionByPath: {},
      reviewExternalChangesByFile: {},
      ...extraState,
    }));
  };

  const replaceActiveChangeSetAfterStaleRefresh = (
    fresh: ReviewChangeSet,
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
      set((state) => ({
        taskHasChanges: { ...state.taskHasChanges, [cacheKey]: data.files.length > 0 },
      }));
      if (data.files.length > 0) {
        taskChangesNegativeCache.delete(cacheKey);
      } else {
        taskChangesNegativeCache.set(cacheKey, Date.now());
      }
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

    taskHasChanges: {},

    fetchAgentChanges: async (teamName: string, memberName: string) => {
      set({ changeSetLoading: true, changeSetError: null });
      try {
        const data = await api.review.getAgentChanges(teamName, memberName);
        installActiveChangeSetForLoad(data, { activeTaskChangeRequestOptions: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch agent changes';
        logger.error('fetchAgentChanges error:', message);
        set({ changeSetError: message, changeSetLoading: false });
      }
    },

    recordTaskHasChanges: (
      teamName: string,
      taskId: string,
      options: TaskChangeRequestOptions,
      hasChanges: boolean
    ) => {
      const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
      set((s) => ({
        taskHasChanges: { ...s.taskHasChanges, [cacheKey]: hasChanges },
      }));
      if (hasChanges) {
        taskChangesNegativeCache.delete(cacheKey);
      } else {
        taskChangesNegativeCache.set(cacheKey, Date.now());
      }
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
          taskHasChanges: { ...get().taskHasChanges, [cacheKey]: data.files.length > 0 },
        });
        if (nextPresence) {
          get().setSelectedTeamTaskChangePresence(teamName, taskId, nextPresence);
        }
        if (data.files.length > 0) {
          taskChangesNegativeCache.delete(cacheKey);
        } else {
          taskChangesNegativeCache.set(cacheKey, Date.now());
        }
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
      latestTaskChangesRequestToken++;
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
      latestTaskChangesRequestToken++;
      set((s) => ({
        activeChangeSet: null,
        changeSetLoading: false,
        changeSetError: null,
        selectedReviewFilePath: null,
        activeTaskChangeRequestOptions: null,
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
      latestTaskChangesRequestToken++;
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

    loadDecisionsFromDisk: async (teamName: string, scopeKey: string) => {
      try {
        const data = await api.review.loadDecisions(teamName, scopeKey);
        // Always set decisions — even to empty if no saved file exists.
        // This prevents stale decisions from a previous scope leaking through.
        set({
          hunkDecisions: data?.hunkDecisions ?? {},
          fileDecisions: data?.fileDecisions ?? {},
          hunkContextHashesByFile: data?.hunkContextHashesByFile ?? {},
        });
      } catch (error) {
        logger.error('loadDecisionsFromDisk error:', error);
      }
    },

    persistDecisions: (teamName: string, scopeKey: string) => {
      if (persistDebounceTimer) {
        clearTimeout(persistDebounceTimer);
      }
      persistDebounceTimer = setTimeout(() => {
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

        // Prune to only files in the current scope. This avoids persisting stale file paths
        // (e.g. from older sessions) that could confuse future replays.
        const mergedHashes: Record<string, Record<number, string>> = {};
        for (const file of activeChangeSet?.files ?? []) {
          const fp = file.filePath;
          mergedHashes[fp] = computed[fp] ?? hunkContextHashesByFile[fp] ?? {};
        }
        // Keep store in sync so replay can use hashes without reload.
        set({ hunkContextHashesByFile: mergedHashes });

        void api.review.saveDecisions(
          teamName,
          scopeKey,
          hunkDecisions,
          fileDecisions,
          mergedHashes
        );
      }, PERSIST_DEBOUNCE_MS);
    },

    clearDecisionsFromDisk: async (teamName: string, scopeKey: string) => {
      try {
        await api.review.clearDecisions(teamName, scopeKey);
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
      // Map current chunk index to original: after accept/reject, chunks shift in CM.
      // We need the original index to keep decisions stable across shifts.
      const originalIndex =
        totalChunks > 0
          ? mapCurrentToOriginalIndex(filePath, hunkIndex, state.hunkDecisions, totalChunks)
          : hunkIndex;
      const key = `${filePath}:${originalIndex}`;
      set((s) => ({
        hunkDecisions: { ...s.hunkDecisions, [key]: decision },
      }));
      return originalIndex;
    },

    clearHunkDecisionByOriginalIndex: (filePath: string, originalIndex: number) => {
      const key = `${filePath}:${originalIndex}`;
      set((s) => {
        if (!(key in s.hunkDecisions)) return s;
        const next = { ...s.hunkDecisions };
        delete next[key];
        return { hunkDecisions: next };
      });
    },

    setFileDecision: (filePath: string, decision: HunkDecision) => {
      set((state) => ({
        fileDecisions: { ...state.fileDecisions, [filePath]: decision },
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
      const file = state.activeChangeSet?.files.find((f) => f.filePath === filePath);
      if (!file) return;

      const count = getFileHunkCount(filePath, file.snippets.length, state.fileChunkCounts);
      const newHunkDecisions = { ...state.hunkDecisions };
      for (let i = 0; i < count; i++) {
        newHunkDecisions[`${filePath}:${i}`] = 'accepted';
      }
      set({
        hunkDecisions: newHunkDecisions,
        fileDecisions: { ...state.fileDecisions, [filePath]: 'accepted' },
      });
    },

    rejectAllFile: (filePath: string) => {
      const state = get();
      const file = state.activeChangeSet?.files.find((f) => f.filePath === filePath);
      if (!file) return;

      const count = getFileHunkCount(filePath, file.snippets.length, state.fileChunkCounts);
      const newHunkDecisions = { ...state.hunkDecisions };
      for (let i = 0; i < count; i++) {
        newHunkDecisions[`${filePath}:${i}`] = 'rejected';
      }
      set({
        hunkDecisions: newHunkDecisions,
        fileDecisions: { ...state.fileDecisions, [filePath]: 'rejected' },
      });
    },

    acceptAll: () => {
      const state = get();
      if (!state.activeChangeSet) return;

      const newHunkDecisions: Record<string, HunkDecision> = {};
      const newFileDecisions: Record<string, HunkDecision> = {};

      for (const file of state.activeChangeSet.files) {
        newFileDecisions[file.filePath] = 'accepted';
        const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
        for (let i = 0; i < count; i++) {
          newHunkDecisions[`${file.filePath}:${i}`] = 'accepted';
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
        newFileDecisions[file.filePath] = 'rejected';
        const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
        for (let i = 0; i < count; i++) {
          newHunkDecisions[`${file.filePath}:${i}`] = 'rejected';
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
        const fileEntry = activeChangeSet?.files.find((f) => f.filePath === filePath);
        const snippets = fileEntry?.snippets ?? [];

        const content = await api.review.getFileContent(teamName, memberName, filePath, snippets);
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
              f.filePath === filePath
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
        const currentFingerprint = current
          ? fingerprintChangeSet(current as ReviewChangeSet)
          : null;
        const staleMessage =
          'Changes have been updated since you started reviewing. Please re-review.';

        if (memberName && current) {
          const fresh = await api.review.getAgentChanges(teamName, memberName);
          if (currentFingerprint !== fingerprintChangeSet(fresh)) {
            replaceActiveChangeSetAfterStaleRefresh(fresh, staleMessage);
            return;
          }
        } else if (taskId && current) {
          const fresh = await api.review.getTaskChanges(teamName, taskId, {
            ...(state.activeTaskChangeRequestOptions ?? {}),
            forceFresh: true,
          });
          if (currentFingerprint !== fingerprintChangeSet(fresh)) {
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
          const fileDecision = fileDecisions[file.filePath] ?? 'pending';
          const hunkDecs: Record<number, HunkDecision> = {};

          const baseCount = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
          const maxIdx = getMaxDecisionIndexForFile(file.filePath, hunkDecisions);
          const count = Math.max(baseCount, maxIdx + 1);
          for (let i = 0; i < count; i++) {
            const key = `${file.filePath}:${i}`;
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

      const file = activeChangeSet.files.find((f) => f.filePath === filePath);
      if (!file) return null;

      const fileDecision = fileDecisions[filePath] ?? 'pending';
      const hunkDecs: Record<number, HunkDecision> = {};
      const baseCount = getFileHunkCount(filePath, file.snippets.length, fileChunkCounts);
      const maxIdx = getMaxDecisionIndexForFile(filePath, hunkDecisions);
      const count = Math.max(baseCount, maxIdx + 1);
      for (let i = 0; i < count; i++) {
        hunkDecs[i] = hunkDecisions[`${filePath}:${i}`] ?? 'pending';
      }

      const hasRejected =
        fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
      if (!hasRejected) return null;

      try {
        const content = fileContents[filePath];
        const innerBaseCount = getFileHunkCount(filePath, file.snippets.length, fileChunkCounts);
        const innerMaxIdx = getMaxDecisionIndexForFile(filePath, hunkDecisions);
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
              filePath,
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
        const existing = s.activeChangeSet.files.find((f) => f.filePath === filePath);
        if (!existing) return s;

        const nextFiles = s.activeChangeSet.files.filter((f) => f.filePath !== filePath);
        const totalLinesAdded = nextFiles.reduce((sum, f) => sum + f.linesAdded, 0);
        const totalLinesRemoved = nextFiles.reduce((sum, f) => sum + f.linesRemoved, 0);

        const nextHunkDecisions = { ...s.hunkDecisions };
        const prefix = `${filePath}:`;
        for (const key of Object.keys(nextHunkDecisions)) {
          if (key.startsWith(prefix)) delete nextHunkDecisions[key];
        }

        const nextFileDecisions = { ...s.fileDecisions };
        delete nextFileDecisions[filePath];

        const nextFileChunkCounts = { ...s.fileChunkCounts };
        delete nextFileChunkCounts[filePath];

        const nextFileContents = { ...s.fileContents };
        delete nextFileContents[filePath];

        const nextFileContentsLoading = { ...s.fileContentsLoading };
        delete nextFileContentsLoading[filePath];

        const nextEditedContents = { ...s.editedContents };
        delete nextEditedContents[filePath];

        const nextHashes = { ...s.hunkContextHashesByFile };
        delete nextHashes[filePath];

        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        delete nextReviewExternalChangesByFile[filePath];

        const nextFileContentVersionByPath = {
          ...s.fileContentVersionByPath,
          [filePath]: (s.fileContentVersionByPath[filePath] ?? 0) + 1,
        };

        const nextSelected =
          s.selectedReviewFilePath === filePath
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
        if (s.activeChangeSet.files.some((f) => f.filePath === file.filePath)) return s;

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
        const prefix = `${filePath}:`;
        for (const key of Object.keys(nextHunkDecisions)) {
          if (key.startsWith(prefix) && nextHunkDecisions[key] === 'rejected') {
            delete nextHunkDecisions[key];
          }
        }

        const nextFileDecisions = { ...s.fileDecisions };
        if (nextFileDecisions[filePath] === 'rejected') {
          delete nextFileDecisions[filePath];
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
      if (summaryCacheable && get().taskHasChanges[cacheKey] === true) {
        get().setSelectedTeamTaskChangePresence(teamName, taskId, 'has_changes');
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
        if (data.files.length > 0) {
          set((s) => ({
            taskHasChanges: { ...s.taskHasChanges, [cacheKey]: true },
          }));
          taskChangesNegativeCache.delete(cacheKey);
          get().setSelectedTeamTaskChangePresence(teamName, taskId, 'has_changes');
          if (wasRestoredBeforeCurrentSession(data)) {
            void revalidateTaskChangePresence(teamName, taskId, options);
          }
        } else {
          set((s) => ({
            taskHasChanges: { ...s.taskHasChanges, [cacheKey]: false },
          }));
          taskChangesNegativeCache.set(cacheKey, Date.now());
          if (nextPresence === 'no_changes') {
            get().setSelectedTeamTaskChangePresence(teamName, taskId, 'no_changes');
          } else if (selectedTask?.changePresence && selectedTask.changePresence !== 'unknown') {
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
        if (get().taskHasChanges[cacheKey] === true || taskChangesCheckInFlight.has(cacheKey)) {
          return;
        }

        taskChangesCheckInFlight.add(cacheKey);
        try {
          const data = await api.review.getTaskChanges(request.teamName, request.taskId, {
            ...request.options,
            summaryOnly: true,
          });
          set((s) => ({
            taskHasChanges: { ...s.taskHasChanges, [cacheKey]: data.files.length > 0 },
          }));
          if (data.files.length > 0) {
            taskChangesNegativeCache.delete(cacheKey);
            if (wasRestoredBeforeCurrentSession(data)) {
              void revalidateTaskChangePresence(request.teamName, request.taskId, request.options);
            }
          } else {
            taskChangesNegativeCache.set(cacheKey, Date.now());
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
        const nextTaskHasChanges = { ...state.taskHasChanges };
        let changed = false;
        for (const key of keySet) {
          if (key in nextTaskHasChanges) {
            delete nextTaskHasChanges[key];
            changed = true;
          }
          taskChangesNegativeCache.delete(key);
        }
        return changed ? { taskHasChanges: nextTaskHasChanges } : {};
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
