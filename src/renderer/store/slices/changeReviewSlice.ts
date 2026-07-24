import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordReviewApplyEnd,
  recordReviewSubmit,
} from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import {
  buildReviewDecisionScopeToken,
  getReviewChangeSetIdentityToken,
  type ReviewChangeSetLike,
  reviewChangeSetMatchesScope,
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
import {
  buildTaskChangePresenceKey,
  buildTaskChangeSignature,
  isTaskSummaryCacheableForOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { createLogger } from '@shared/utils/logger';
import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';
import { buildReviewChunkContextHashes } from '@shared/utils/reviewChunks';

/** Tracks in-flight checkTaskHasChanges calls to avoid duplicate requests */
const taskChangesCheckInFlight = new Set<string>();
/** Tracks background presence revalidation for optimistic terminal summary hits */
const taskChangesPresenceRevalidationInFlight = new Set<string>();
/** Rate-limits forced refreshes for cached needs_attention hits */
const taskChangesNeedsAttentionRevalidationTs = new Map<string, number>();
/** Negative results cached with timestamp — recheck after 30s */
const taskChangesNegativeCache = new Map<string, number>();
const NEGATIVE_CACHE_TTL = 30_000;
const NEEDS_ATTENTION_REVALIDATION_TTL = 30_000;
const TASK_CHANGE_WARM_CONCURRENCY = 4;
const CHANGE_REVIEW_SLICE_BOOT_TIME = Date.now();
let latestAgentChangesRequestToken = 0;
let latestTaskChangesRequestToken = 0;
let latestDecisionLoadRequestToken = 0;

/** Debounce timer for persisting decisions to disk */
const persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPersistDecisionWrites = new Map<string, () => Promise<void>>();
const persistDecisionWriteChains = new Map<string, Promise<void>>();
const decisionRevisionByScope = new Map<string, number>();
const PERSIST_DEBOUNCE_MS = 500;

function reviewPersistedSnapshotsEqual(
  left: ReviewPersistedStateSnapshot,
  right: ReviewPersistedStateSnapshot
): boolean {
  return (
    JSON.stringify(left.hunkDecisions) === JSON.stringify(right.hunkDecisions) &&
    JSON.stringify(left.fileDecisions) === JSON.stringify(right.fileDecisions) &&
    JSON.stringify(left.hunkContextHashesByFile ?? {}) ===
      JSON.stringify(right.hunkContextHashesByFile ?? {}) &&
    JSON.stringify(left.reviewActionHistory) === JSON.stringify(right.reviewActionHistory) &&
    JSON.stringify(left.reviewRedoHistory) === JSON.stringify(right.reviewRedoHistory)
  );
}

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
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
  TaskChangePresenceState,
  TaskChangeSet,
  TaskChangeSetV2,
} from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('changeReviewSlice');

function buildApplyDecisionPersistenceScope(
  changeSet: ReviewChangeSetLike,
  teamName: string,
  taskChangeRequestOptions: TaskChangeRequestOptions | null,
  taskId?: string,
  memberName?: string
): ReviewDecisionPersistenceScope | undefined {
  const mode = taskId ? 'task' : memberName ? 'agent' : null;
  if (!mode) return undefined;
  if (!reviewChangeSetMatchesScope(changeSet, { teamName, taskId, memberName })) {
    return undefined;
  }
  const scopeToken = buildReviewDecisionScopeToken({
    mode,
    taskId,
    memberName,
    requestSignature:
      mode === 'task' ? buildTaskChangeSignature(taskChangeRequestOptions ?? {}) : undefined,
    changeSet,
  });
  if (!scopeToken) return undefined;
  return {
    scopeKey: mode === 'task' ? `task-${taskId}` : `agent-${memberName}`,
    scopeToken,
  };
}

function buildReviewPersistedStateSnapshot(
  state: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile: Record<string, Record<number, string>>;
    reviewActionHistory: ReviewUndoAction[];
    reviewRedoHistory: ReviewRedoAction[];
  },
  decisions: readonly FileReviewDecision[]
): ReviewPersistedStateSnapshot {
  const hunkContextHashesByFile = { ...state.hunkContextHashesByFile };
  for (const decision of decisions) {
    if (decision.reviewKey && decision.hunkContextHashes) {
      hunkContextHashesByFile[decision.reviewKey] = decision.hunkContextHashes;
    }
  }
  return {
    hunkDecisions: { ...state.hunkDecisions },
    fileDecisions: { ...state.fileDecisions },
    hunkContextHashesByFile,
    reviewActionHistory: [...state.reviewActionHistory],
    reviewRedoHistory: structuredClone(state.reviewRedoHistory),
  };
}

function reviewPathsEqual(left: string, right: string): boolean {
  const caseInsensitive = isWindowsReviewPath(left) || isWindowsReviewPath(right);
  return (
    normalizeReviewPathForComparison(left, caseInsensitive) ===
    normalizeReviewPathForComparison(right, caseInsensitive)
  );
}

function normalizeReviewPathForComparison(filePath: string, caseInsensitive: boolean): string {
  const normalized = normalizePathForComparison(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
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

export type SaveEditedReviewFileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
    };

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
  if (timer) {
    clearTimeout(timer);
    persistDebounceTimers.delete(scopeStorageKey);
  }
  pendingPersistDecisionWrites.delete(scopeStorageKey);
}

function enqueuePersistDecisionWrite(
  scopeStorageKey: string,
  write: () => Promise<void>
): Promise<void> {
  const previous = persistDecisionWriteChains.get(scopeStorageKey) ?? Promise.resolve();
  // A newer snapshot supersedes a failed older write, but must never overtake an older
  // in-flight write or that write could later restore stale decisions on disk.
  const current = previous.catch(() => undefined).then(write);
  persistDecisionWriteChains.set(scopeStorageKey, current);
  void current.then(
    () => {
      if (persistDecisionWriteChains.get(scopeStorageKey) === current) {
        persistDecisionWriteChains.delete(scopeStorageKey);
      }
    },
    () => {
      if (persistDecisionWriteChains.get(scopeStorageKey) === current) {
        persistDecisionWriteChains.delete(scopeStorageKey);
      }
    }
  );
  return current;
}

function buildPersistDecisionScopeKey(
  teamName: string,
  scopeKey: string,
  scopeToken?: string
): string {
  return scopeToken ? `${teamName}:${scopeKey}:${scopeToken}` : `${teamName}:${scopeKey}`;
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

interface TaskChangePresenceCacheUpdate {
  cacheKey: string;
  presence: TaskChangePresenceState | null;
}

function applyTaskChangePresenceCacheUpdates(
  taskChangePresenceByKey: Record<string, Exclude<TaskChangePresenceState, 'unknown'>>,
  updates: readonly TaskChangePresenceCacheUpdate[]
): Record<string, Exclude<TaskChangePresenceState, 'unknown'>> {
  let nextTaskChangePresenceByKey = taskChangePresenceByKey;
  for (const { cacheKey, presence } of updates) {
    if (presence && presence !== 'unknown') {
      if (nextTaskChangePresenceByKey[cacheKey] === presence) {
        continue;
      }
      if (nextTaskChangePresenceByKey === taskChangePresenceByKey) {
        nextTaskChangePresenceByKey = { ...taskChangePresenceByKey };
      }
      nextTaskChangePresenceByKey[cacheKey] = presence;
      continue;
    }
    if (!(cacheKey in nextTaskChangePresenceByKey)) {
      continue;
    }
    if (nextTaskChangePresenceByKey === taskChangePresenceByKey) {
      nextTaskChangePresenceByKey = { ...taskChangePresenceByKey };
    }
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
  /** Durable, ordered and self-contained Accept/Reject Undo history. */
  reviewActionHistory: ReviewUndoAction[];
  /** Durable Redo branch. Cleared by the next successful review action. */
  reviewRedoHistory: ReviewRedoAction[];
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
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
  decisionRevision: number;

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
  recordTaskChangePresences: (
    entries: {
      teamName: string;
      taskId: string;
      options: TaskChangeRequestOptions;
      presence: TaskChangePresenceState | null;
    }[]
  ) => void;
  selectReviewFile: (filePath: string | null) => void;
  clearChangeReview: () => void;
  clearChangeReviewCache: () => void;
  resetAllReviewState: () => void;
  fetchChangeStats: (teamName: string, memberName: string) => Promise<void>;

  // Decision persistence actions
  loadDecisionsFromDisk: (teamName: string, scopeKey: string, scopeToken: string) => Promise<void>;
  persistDecisions: (teamName: string, scopeKey: string, scopeToken: string) => void;
  flushDecisionsToDisk: (
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ) => Promise<boolean>;
  quiesceDecisionPersistence: (
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ) => Promise<boolean>;
  clearDecisionsFromDisk: (
    teamName: string,
    scopeKey: string,
    scopeToken?: string,
    forceDiscard?: boolean
  ) => Promise<boolean>;
  recordDecisionRevision: (
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    revision: number
  ) => void;

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
  setReviewActionHistory: (history: ReviewUndoAction[]) => void;
  setReviewRedoHistory: (history: ReviewRedoAction[]) => void;
  pushReviewUndoSnapshot: () => void;
  undoBulkReview: () => boolean;
  /** Accept only still-pending hunks. Returns false when the file has nothing pending. */
  acceptAllFile: (filePath: string) => boolean;
  rejectAllFile: (filePath: string) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  setCollapseUnchanged: (collapse: boolean) => void;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  applyReview: (
    teamName: string,
    taskId?: string,
    memberName?: string
  ) => Promise<ApplyReviewResult | null>;
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
  saveEditedFile: (
    filePath: string,
    scope: ReviewFileScope,
    expectedCurrentContent: string | null
  ) => Promise<SaveEditedReviewFileResult>;

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

  const hashes = buildReviewChunkContextHashes(original, modified);
  const count = Object.keys(hashes).length;
  if (count === 0 || count !== expectedHunkCount) return undefined;
  return hashes;
}

export const createChangeReviewSlice: StateCreator<AppState, [], [], ChangeReviewSlice> = (
  set,
  get
) => {
  const addMatchingReviewPathAliases = (
    aliases: Set<string>,
    filePath: string,
    canonicalFilePath: string,
    record: Record<string, unknown>
  ): void => {
    for (const key of Object.keys(record)) {
      if (reviewPathsEqual(key, filePath) || reviewPathsEqual(key, canonicalFilePath)) {
        aliases.add(key);
      }
    }
  };

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
    const existing = findReviewFileByPath(s.activeChangeSet?.files, filePath);
    const canonicalFilePath = existing?.filePath ?? filePath;
    const aliases = new Set([filePath, canonicalFilePath]);
    addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileChunkCounts);
    addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileContents);
    addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileContentsLoading);
    addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileContentVersionByPath);
    const nextFileChunkCounts = { ...s.fileChunkCounts };
    for (const alias of aliases) delete nextFileChunkCounts[alias];

    const nextFileContents = { ...s.fileContents };
    for (const alias of aliases) delete nextFileContents[alias];

    const nextFileContentsLoading = { ...s.fileContentsLoading };
    for (const alias of aliases) delete nextFileContentsLoading[alias];

    const nextHunkContextHashesByFile = { ...s.hunkContextHashesByFile };
    const reviewKey = getReviewKeyForFilePath(s.activeChangeSet?.files, filePath);
    delete nextHunkContextHashesByFile[reviewKey];
    for (const alias of aliases) delete nextHunkContextHashesByFile[alias];

    const nextFileContentVersionByPath = { ...s.fileContentVersionByPath };
    for (const alias of aliases) {
      nextFileContentVersionByPath[alias] = (s.fileContentVersionByPath[alias] ?? 0) + 1;
    }

    return {
      fileChunkCounts: nextFileChunkCounts,
      fileContents: nextFileContents,
      fileContentsLoading: nextFileContentsLoading,
      hunkContextHashesByFile: nextHunkContextHashesByFile,
      fileContentVersionByPath: nextFileContentVersionByPath,
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
      reviewActionHistory: [],
      reviewRedoHistory: [],
      hunkContextHashesByFile: {},
      applyError: null,
      applying: false,
      decisionHydrationScopeKey: null,
      decisionHydrationStatus: 'idle',
      decisionRevision: 0,
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
      reviewActionHistory: [],
      reviewRedoHistory: [],
      hunkContextHashesByFile: {},
      fileContents: {},
      fileContentsLoading: {},
      editedContents: {},
      decisionHydrationScopeKey: null,
      decisionHydrationStatus: 'idle',
      decisionRevision: 0,
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
    reviewActionHistory: [],
    reviewRedoHistory: [],
    hunkContextHashesByFile: {},
    fileContents: {},
    fileContentsLoading: {},
    changeSetEpoch: 0,
    fileContentVersionByPath: {},
    reviewExternalChangesByFile: {},
    collapseUnchanged: true,
    applyError: null,
    applying: false,
    decisionHydrationScopeKey: null,
    decisionHydrationStatus: 'idle',
    decisionRevision: 0,

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
      get().recordTaskChangePresences([{ teamName, taskId, options, presence }]);
    },

    recordTaskChangePresences: (entries) => {
      if (entries.length === 0) {
        return;
      }
      const updates = entries.map(({ teamName, taskId, options, presence }) => ({
        cacheKey: buildTaskChangePresenceKey(teamName, taskId, options),
        presence,
      }));
      set((s) => {
        const nextTaskChangePresenceByKey = applyTaskChangePresenceCacheUpdates(
          s.taskChangePresenceByKey,
          updates
        );
        if (nextTaskChangePresenceByKey === s.taskChangePresenceByKey) {
          return {};
        }
        return { taskChangePresenceByKey: nextTaskChangePresenceByKey };
      });
      for (const update of updates) {
        syncTaskChangeNegativeCache(update.cacheKey, update.presence);
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
        reviewActionHistory: [],
        reviewRedoHistory: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        decisionHydrationScopeKey: null,
        decisionHydrationStatus: 'idle',
        decisionRevision: 0,
        editedContents: {},
      }));
    },

    clearChangeReviewCache: () => {
      latestAgentChangesRequestToken++;
      latestTaskChangesRequestToken++;
      latestDecisionLoadRequestToken++;
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
        reviewActionHistory: [],
        reviewRedoHistory: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        decisionHydrationScopeKey: null,
        decisionHydrationStatus: 'idle',
        decisionRevision: 0,
        editedContents: {},
      }));
    },

    resetAllReviewState: () => {
      latestAgentChangesRequestToken++;
      latestTaskChangesRequestToken++;
      latestDecisionLoadRequestToken++;
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
        reviewActionHistory: [],
        reviewRedoHistory: [],
        hunkContextHashesByFile: {},
        fileContents: {},
        fileContentsLoading: {},
        changeSetEpoch: s.changeSetEpoch + 1,
        fileContentVersionByPath: {},
        reviewExternalChangesByFile: {},
        applyError: null,
        applying: false,
        decisionHydrationScopeKey: null,
        decisionHydrationStatus: 'idle',
        decisionRevision: 0,
        editedContents: {},
      }));
    },

    // ── Decision persistence ──

    loadDecisionsFromDisk: async (teamName: string, scopeKey: string, scopeToken: string) => {
      const requestToken = ++latestDecisionLoadRequestToken;
      const hydrationScopeKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      const startState = get();
      const changeSetEpoch = startState.changeSetEpoch;
      const initialHunkDecisions = startState.hunkDecisions;
      const initialFileDecisions = startState.fileDecisions;
      const preserveInMemoryRecovery =
        startState.decisionHydrationStatus === 'error' &&
        (Object.keys(initialHunkDecisions).length > 0 ||
          Object.keys(initialFileDecisions).length > 0);
      set({
        decisionHydrationScopeKey: hydrationScopeKey,
        decisionHydrationStatus: 'loading',
      });
      try {
        const data = await api.review.loadDecisions(teamName, scopeKey, scopeToken);
        if (requestToken !== latestDecisionLoadRequestToken) return;
        const latest = get();
        if (latest.changeSetEpoch !== changeSetEpoch) return;
        decisionRevisionByScope.set(hydrationScopeKey, data?.revision ?? 0);
        // A user decision made while the disk read was in flight must win over persisted state.
        if (
          latest.hunkDecisions !== initialHunkDecisions ||
          latest.fileDecisions !== initialFileDecisions
        ) {
          set({
            decisionHydrationScopeKey: hydrationScopeKey,
            decisionHydrationStatus: 'error',
            applyError:
              'Review changed before saved decisions loaded. Reload Changes before continuing.',
          });
          return;
        }
        if (preserveInMemoryRecovery) {
          // A choice that beat or survived a failed hydration is newer than disk.
          // Retry verifies the store is readable, then keeps that user-owned state.
          set({
            decisionHydrationScopeKey: hydrationScopeKey,
            decisionHydrationStatus: 'loaded',
            decisionRevision: data?.revision ?? 0,
            applyError: null,
          });
          return;
        }
        const normalized = normalizePersistedReviewState(latest.activeChangeSet?.files ?? [], {
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
          reviewActionHistory: data?.reviewActionHistory ?? [],
          reviewRedoHistory: data?.reviewRedoHistory ?? [],
          decisionHydrationScopeKey: hydrationScopeKey,
          decisionHydrationStatus: 'loaded',
          decisionRevision: data?.revision ?? 0,
          applyError: null,
        });
      } catch (error) {
        if (requestToken !== latestDecisionLoadRequestToken) return;
        const latest = get();
        if (latest.changeSetEpoch !== changeSetEpoch) return;
        if (
          latest.hunkDecisions !== initialHunkDecisions ||
          latest.fileDecisions !== initialFileDecisions
        ) {
          set({
            decisionHydrationScopeKey: hydrationScopeKey,
            decisionHydrationStatus: 'error',
            applyError:
              'Review changed while saved decisions failed to load. Reload Changes before continuing.',
          });
          return;
        }
        logger.error('loadDecisionsFromDisk error:', error);
        set({
          decisionHydrationScopeKey: hydrationScopeKey,
          decisionHydrationStatus: 'error',
          applyError: 'Unable to load saved review decisions. Reload Changes before reviewing.',
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
        reviewActionHistory,
        reviewRedoHistory,
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
      const persistedHashes = Object.fromEntries(
        Object.entries(mergedHashes).map(([filePath, hashes]) => [filePath, { ...hashes }])
      );
      const persistedReviewActionHistory = structuredClone(reviewActionHistory);
      const persistedReviewRedoHistory = structuredClone(reviewRedoHistory);
      const queuedSnapshot: ReviewPersistedStateSnapshot = {
        hunkDecisions: persistedHunkDecisions,
        fileDecisions: persistedFileDecisions,
        hunkContextHashesByFile: persistedHashes,
        reviewActionHistory: persistedReviewActionHistory,
        reviewRedoHistory: persistedReviewRedoHistory,
      };
      const write = async (): Promise<void> => {
        const expectedRevision = decisionRevisionByScope.get(scopeStorageKey) ?? 0;
        const saved = await api.review.saveDecisions(
          teamName,
          scopeKey,
          scopeToken,
          persistedHunkDecisions,
          persistedFileDecisions,
          persistedHashes,
          persistedReviewActionHistory,
          expectedRevision,
          persistedReviewRedoHistory
        );
        decisionRevisionByScope.set(scopeStorageKey, saved.revision);
        const latest = get();
        if (
          saved.reconciledState &&
          latest.decisionHydrationScopeKey === scopeStorageKey &&
          latest.decisionHydrationStatus === 'loaded'
        ) {
          const liveSnapshot: ReviewPersistedStateSnapshot = {
            hunkDecisions: latest.hunkDecisions,
            fileDecisions: latest.fileDecisions,
            hunkContextHashesByFile: latest.hunkContextHashesByFile,
            reviewActionHistory: latest.reviewActionHistory,
            reviewRedoHistory: latest.reviewRedoHistory,
          };
          if (!reviewPersistedSnapshotsEqual(liveSnapshot, queuedSnapshot)) {
            set({
              decisionHydrationStatus: 'error',
              applyError:
                'Saved review advanced while local actions changed. Reload Changes before continuing.',
            });
            throw new Error('Review reconciliation raced a newer local action');
          }
          const normalized = normalizePersistedReviewState(
            latest.activeChangeSet?.files ?? [],
            saved.reconciledState
          );
          set({
            hunkDecisions: normalized.hunkDecisions,
            fileDecisions: normalized.fileDecisions,
            hunkContextHashesByFile: normalized.hunkContextHashesByFile,
            reviewActionHistory: saved.reconciledState.reviewActionHistory,
            reviewRedoHistory: saved.reconciledState.reviewRedoHistory,
            decisionRevision: saved.revision,
          });
          return;
        }
        if (
          latest.decisionHydrationScopeKey === scopeStorageKey &&
          latest.decisionHydrationStatus === 'loaded'
        ) {
          set({ decisionRevision: saved.revision });
        }
      };
      pendingPersistDecisionWrites.set(scopeStorageKey, write);

      const timer = setTimeout(() => {
        persistDebounceTimers.delete(scopeStorageKey);
        pendingPersistDecisionWrites.delete(scopeStorageKey);
        void enqueuePersistDecisionWrite(scopeStorageKey, write).catch((error) =>
          logger.error('persistDecisions error:', error)
        );
      }, PERSIST_DEBOUNCE_MS);

      persistDebounceTimers.set(scopeStorageKey, timer);
    },

    flushDecisionsToDisk: async (teamName: string, scopeKey: string, scopeToken: string) => {
      const scopeStorageKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      const write = pendingPersistDecisionWrites.get(scopeStorageKey);
      try {
        if (write) {
          const timer = persistDebounceTimers.get(scopeStorageKey);
          if (timer) clearTimeout(timer);
          persistDebounceTimers.delete(scopeStorageKey);
          pendingPersistDecisionWrites.delete(scopeStorageKey);
          await enqueuePersistDecisionWrite(scopeStorageKey, write);
        } else {
          await persistDecisionWriteChains.get(scopeStorageKey);
        }
        return true;
      } catch (error) {
        logger.error('flushDecisionsToDisk error:', error);
        return false;
      }
    },

    quiesceDecisionPersistence: async (teamName: string, scopeKey: string, scopeToken: string) => {
      const scopeStorageKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      // Drop a debounced post-click snapshot: the WAL will commit that state only
      // after its disk effects. Already-started older writes must finish first.
      clearPersistDecisionTimer(scopeStorageKey);
      try {
        await persistDecisionWriteChains.get(scopeStorageKey);
        const revision = decisionRevisionByScope.get(scopeStorageKey) ?? 0;
        if (get().decisionHydrationScopeKey === scopeStorageKey) {
          set({ decisionRevision: revision });
        }
        return true;
      } catch (error) {
        logger.error('quiesceDecisionPersistence error:', error);
        return false;
      }
    },

    clearDecisionsFromDisk: async (
      teamName: string,
      scopeKey: string,
      scopeToken?: string,
      forceDiscard = false
    ) => {
      const scopeStorageKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      clearPersistDecisionTimer(scopeStorageKey);
      try {
        await enqueuePersistDecisionWrite(scopeStorageKey, async () => {
          const cleared = await api.review.clearDecisions(
            teamName,
            scopeKey,
            scopeToken,
            forceDiscard ? undefined : (decisionRevisionByScope.get(scopeStorageKey) ?? 0)
          );
          decisionRevisionByScope.set(scopeStorageKey, cleared.revision);
          if (get().decisionHydrationScopeKey === scopeStorageKey) {
            set({ decisionRevision: cleared.revision });
          }
        });
        return true;
      } catch (error) {
        logger.error('clearDecisionsFromDisk error:', error);
        return false;
      }
    },

    recordDecisionRevision: (
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      revision: number
    ) => {
      const scopeStorageKey = buildPersistDecisionScopeKey(teamName, scopeKey, scopeToken);
      decisionRevisionByScope.set(scopeStorageKey, revision);
      if (get().decisionHydrationScopeKey === scopeStorageKey) {
        set({ decisionRevision: revision });
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

    setReviewActionHistory: (history: ReviewUndoAction[]) => {
      set({ reviewActionHistory: history });
    },

    setReviewRedoHistory: (history: ReviewRedoAction[]) => {
      set({ reviewRedoHistory: history });
    },

    pushReviewUndoSnapshot: () => {
      const state = get();
      const snapshot: DecisionSnapshot = {
        hunkDecisions: { ...state.hunkDecisions },
        fileDecisions: { ...state.fileDecisions },
      };
      const stack = [...state.reviewUndoStack, snapshot];
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
      if (!file) return false;

      const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
      const newHunkDecisions = { ...state.hunkDecisions };
      const reviewKey = getFileReviewKey(file);
      const fileDecision =
        state.fileDecisions[reviewKey] ?? state.fileDecisions[file.filePath] ?? 'pending';
      if (fileDecision !== 'pending') return false;

      if (count === 0) {
        set({
          fileDecisions: { ...state.fileDecisions, [reviewKey]: 'accepted' },
        });
        return true;
      }

      let acceptedPending = false;
      let hasRejected = false;
      for (let i = 0; i < count; i++) {
        const key = buildHunkDecisionKey(reviewKey, i);
        const decision =
          state.hunkDecisions[key] ??
          state.hunkDecisions[buildHunkDecisionKey(file.filePath, i)] ??
          'pending';
        if (decision === 'rejected') {
          hasRejected = true;
        } else if (decision === 'pending') {
          newHunkDecisions[key] = 'accepted';
          acceptedPending = true;
        }
      }

      if (!acceptedPending) return false;

      const newFileDecisions = { ...state.fileDecisions };
      if (hasRejected) {
        delete newFileDecisions[reviewKey];
      } else {
        newFileDecisions[reviewKey] = 'accepted';
      }
      set({
        hunkDecisions: newHunkDecisions,
        fileDecisions: newFileDecisions,
      });
      return true;
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
      const fileEntry = findReviewFileByPath(state.activeChangeSet?.files, filePath);
      const canonicalFilePath = fileEntry?.filePath ?? filePath;
      // Skip if already loaded or loading
      if (
        state.fileContents[filePath] ||
        state.fileContents[canonicalFilePath] ||
        state.fileContentsLoading[filePath] ||
        state.fileContentsLoading[canonicalFilePath]
      )
        return;
      const changeSetEpoch = state.changeSetEpoch;
      const fileVersion = state.fileContentVersionByPath[filePath] ?? 0;
      const canonicalFileVersion = state.fileContentVersionByPath[canonicalFilePath] ?? 0;

      set((s) => ({
        fileContentsLoading: {
          ...s.fileContentsLoading,
          [filePath]: true,
          [canonicalFilePath]: true,
        },
      }));

      try {
        const snippets = fileEntry?.snippets ?? [];

        const content = await api.review.getFileContent(
          teamName,
          memberName,
          canonicalFilePath,
          snippets
        );
        const latest = get();
        if (changeSetEpoch !== latest.changeSetEpoch) return;
        if ((latest.fileContentVersionByPath[filePath] ?? 0) !== fileVersion) return;
        if ((latest.fileContentVersionByPath[canonicalFilePath] ?? 0) !== canonicalFileVersion)
          return;
        set((s) => {
          const nextFileContents = { ...s.fileContents, [canonicalFilePath]: content };
          if (canonicalFilePath !== filePath) {
            delete nextFileContents[filePath];
          }
          const result: Partial<ChangeReviewSlice> = {
            fileContents: nextFileContents,
            fileContentsLoading: {
              ...s.fileContentsLoading,
              [filePath]: false,
              [canonicalFilePath]: false,
            },
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
        if ((latest.fileContentVersionByPath[canonicalFilePath] ?? 0) !== canonicalFileVersion)
          return;
        logger.error('fetchFileContent error:', error);
        set((s) => ({
          fileContentsLoading: {
            ...s.fileContentsLoading,
            [filePath]: false,
            [canonicalFilePath]: false,
          },
        }));
      }
    },

    applyReview: async (teamName: string, taskId?: string, memberName?: string) => {
      const applyStartedAtMs = Date.now();
      let applyDecision: 'approve' | 'request_changes' | 'mixed' | 'unknown' = 'unknown';
      let applyFilesCount: number | null = null;
      let applyAcceptedCount: number | null = null;
      let applyRejectedCount: number | null = null;
      const startState = get();
      const changeSetEpoch = startState.changeSetEpoch;
      const current = startState.activeChangeSet;
      if (!reviewChangeSetMatchesScope(current, { teamName, taskId, memberName })) {
        set({ applyError: 'Review scope changed. Reload Changes before applying.' });
        return null;
      }
      const currentFingerprint = getReviewChangeSetIdentityToken(current);
      const isCurrentScope = (): boolean => {
        const latest = get();
        return (
          latest.changeSetEpoch === changeSetEpoch &&
          reviewChangeSetMatchesScope(latest.activeChangeSet, {
            teamName,
            taskId,
            memberName,
          }) &&
          getReviewChangeSetIdentityToken(latest.activeChangeSet) === currentFingerprint
        );
      };

      set({ applying: true, applyError: null });

      try {
        // Stale check: re-fetch changes and compare content fingerprint
        const staleMessage =
          'Changes have been updated since you started reviewing. Please re-review.';

        if (taskId && current) {
          const fresh = await api.review.getTaskChanges(teamName, taskId, {
            ...(startState.activeTaskChangeRequestOptions ?? {}),
            forceFresh: true,
          });
          if (!isCurrentScope()) return null;
          if (!reviewChangeSetMatchesScope(fresh, { teamName, taskId })) {
            set({ applyError: 'Review scope changed. Reload Changes before applying.' });
            return null;
          }
          if (currentFingerprint !== getReviewChangeSetIdentityToken(fresh)) {
            replaceActiveChangeSetAfterStaleRefresh(fresh, staleMessage);
            return null;
          }
        } else if (memberName && current) {
          const fresh = await api.review.getAgentChanges(teamName, memberName);
          if (!isCurrentScope()) return null;
          if (!reviewChangeSetMatchesScope(fresh, { teamName, memberName })) {
            set({ applyError: 'Review scope changed. Reload Changes before applying.' });
            return null;
          }
          if (currentFingerprint !== getReviewChangeSetIdentityToken(fresh)) {
            replaceActiveChangeSetAfterStaleRefresh(fresh, staleMessage);
            return null;
          }
        }

        if (!isCurrentScope()) return null;

        // Build FileReviewDecision[] from hunkDecisions/fileDecisions
        const { hunkDecisions, fileDecisions, fileChunkCounts, activeChangeSet, fileContents } =
          get();
        if (!activeChangeSet) {
          set({ applying: false });
          return null;
        }
        applyFilesCount = activeChangeSet.files.length;

        const decisions: FileReviewDecision[] = [];
        let acceptedCount = 0;
        let rejectedCount = 0;
        let requestChangesCount = 0;

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

          if (fileDecision === 'accepted') {
            acceptedCount += count;
          } else if (fileDecision === 'rejected') {
            rejectedCount += count;
          } else {
            for (const decision of Object.values(hunkDecs)) {
              if (decision === 'accepted') acceptedCount++;
              if (decision === 'rejected') rejectedCount++;
            }
          }

          // Only include files that have at least one rejected hunk
          const hasRejected =
            fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
          if (hasRejected) {
            if (file.filePath in get().editedContents) {
              set({
                applying: false,
                applyError: 'Save or discard manual edits before reviewing this file.',
              });
              return null;
            }
            requestChangesCount++;
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
              reviewKey,
              fileDecision,
              hunkDecisions: hunkDecs,
              contentSnapshotToken: content?.reviewSnapshotToken,
              hunkContextHashes,
            });
          }
        }

        if (decisions.length === 0) {
          if (acceptedCount > 0) {
            applyDecision = 'approve';
            applyAcceptedCount = acceptedCount;
            applyRejectedCount = rejectedCount;
            recordReviewSubmit({
              decision: 'approve',
              filesCount: activeChangeSet.files.length,
              acceptedCount,
              rejectedCount,
              requestChangesCount,
            });
            recordReviewApplyEnd({
              success: true,
              decision: applyDecision,
              filesCount: activeChangeSet.files.length,
              acceptedCount,
              rejectedCount,
              durationMs: elapsedMsSince(applyStartedAtMs),
              errorClass: 'none',
            });
          }
          set({ applying: false });
          return null;
        }

        const decisionPersistenceScope = buildApplyDecisionPersistenceScope(
          activeChangeSet,
          teamName,
          startState.activeTaskChangeRequestOptions,
          taskId,
          memberName
        );
        if (
          decisionPersistenceScope &&
          !(await get().quiesceDecisionPersistence(
            teamName,
            decisionPersistenceScope.scopeKey,
            decisionPersistenceScope.scopeToken
          ))
        ) {
          throw new Error('Unable to finish saving the previous review state. Retry Apply.');
        }
        const request: ApplyReviewRequest = {
          teamName,
          taskId,
          memberName,
          decisionPersistenceScope,
          persistedState: buildReviewPersistedStateSnapshot(get(), decisions),
          ...(decisionPersistenceScope ? { expectedDecisionRevision: get().decisionRevision } : {}),
          decisions,
        };

        const result = await api.review.applyDecisions(request);
        if (!isCurrentScope()) return result;
        if (result.decisionRevision !== undefined && decisionPersistenceScope) {
          get().recordDecisionRevision(
            teamName,
            decisionPersistenceScope.scopeKey,
            decisionPersistenceScope.scopeToken,
            result.decisionRevision
          );
        }
        if (result.errors.length > 0) {
          set({
            applying: false,
            applyError: result.errors.map((entry) => entry.error).join('\n'),
          });
          recordReviewApplyEnd({
            success: false,
            decision: 'request_changes',
            filesCount: activeChangeSet.files.length,
            acceptedCount,
            rejectedCount,
            durationMs: elapsedMsSince(applyStartedAtMs),
            errorClass: result.conflicts > 0 ? 'validation' : 'unknown',
          });
          return result;
        }
        applyDecision = acceptedCount > 0 && rejectedCount > 0 ? 'mixed' : 'request_changes';
        applyAcceptedCount = acceptedCount;
        applyRejectedCount = rejectedCount;
        recordReviewSubmit({
          decision: applyDecision,
          filesCount: activeChangeSet.files.length,
          acceptedCount,
          rejectedCount,
          requestChangesCount,
        });
        recordReviewApplyEnd({
          success: true,
          decision: applyDecision,
          filesCount: activeChangeSet.files.length,
          acceptedCount,
          rejectedCount,
          durationMs: elapsedMsSince(applyStartedAtMs),
          errorClass: 'none',
        });

        set({ applying: false });
        return result;
      } catch (error) {
        recordReviewApplyEnd({
          success: false,
          decision: applyDecision,
          filesCount: applyFilesCount ?? get().activeChangeSet?.files.length ?? null,
          acceptedCount: applyAcceptedCount,
          rejectedCount: applyRejectedCount,
          durationMs: elapsedMsSince(applyStartedAtMs),
          errorClass: classifyAnalyticsError(error),
        });
        logger.error('applyReview error:', error);
        if (!isCurrentScope()) return null;
        set({
          applying: false,
          applyError: mapReviewError(error),
        });
        return null;
      }
    },

    applySingleFileDecision: async (
      teamName: string,
      filePath: string,
      taskId?: string,
      memberName?: string
    ) => {
      const startState = get();
      const {
        hunkDecisions,
        fileDecisions,
        fileChunkCounts,
        activeChangeSet,
        fileContents,
        changeSetEpoch,
      } = startState;
      if (!reviewChangeSetMatchesScope(activeChangeSet, { teamName, taskId, memberName })) {
        set({ applyError: 'Review scope changed. Reload Changes before applying.' });
        return null;
      }

      const file = findReviewFileByPath(activeChangeSet.files, filePath);
      if (!file) return null;
      if (file.filePath in startState.editedContents || filePath in startState.editedContents) {
        set({ applyError: 'Save or discard manual edits before reviewing this file.' });
        return null;
      }
      const scopeFingerprint = getReviewChangeSetIdentityToken(activeChangeSet);
      const isCurrentScope = (): boolean => {
        const latest = get();
        return (
          latest.changeSetEpoch === changeSetEpoch &&
          reviewChangeSetMatchesScope(latest.activeChangeSet, {
            teamName,
            taskId,
            memberName,
          }) &&
          getReviewChangeSetIdentityToken(latest.activeChangeSet) === scopeFingerprint
        );
      };

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
      set({ applyError: null });

      const applyStartedAtMs = Date.now();
      const acceptedCount =
        fileDecision === 'accepted'
          ? count
          : Object.values(hunkDecs).filter((decision) => decision === 'accepted').length;
      const rejectedCount =
        fileDecision === 'rejected'
          ? count
          : Object.values(hunkDecs).filter((decision) => decision === 'rejected').length;

      try {
        const content = fileContents[file.filePath] ?? fileContents[filePath];
        const innerBaseCount = getFileHunkCount(
          file.filePath,
          file.snippets.length,
          fileChunkCounts
        );
        const innerMaxIdx = getMaxDecisionIndexForFile(reviewKey, hunkDecisions);
        const hunkContextHashes =
          innerMaxIdx < innerBaseCount
            ? buildHunkContextHashesForFile(
                content?.originalFullContent,
                content?.modifiedFullContent,
                innerBaseCount
              )
            : undefined;
        const decision: FileReviewDecision = {
          filePath: file.filePath,
          reviewKey,
          fileDecision,
          hunkDecisions: hunkDecs,
          contentSnapshotToken: content?.reviewSnapshotToken,
          hunkContextHashes,
        };
        const decisionPersistenceScope = buildApplyDecisionPersistenceScope(
          activeChangeSet,
          teamName,
          startState.activeTaskChangeRequestOptions,
          taskId,
          memberName
        );
        if (
          decisionPersistenceScope &&
          !(await get().quiesceDecisionPersistence(
            teamName,
            decisionPersistenceScope.scopeKey,
            decisionPersistenceScope.scopeToken
          ))
        ) {
          throw new Error('Unable to finish saving the previous review state. Retry Apply.');
        }
        const result = await api.review.applyDecisions({
          teamName,
          taskId,
          memberName,
          decisionPersistenceScope,
          persistedState: buildReviewPersistedStateSnapshot(get(), [decision]),
          ...(decisionPersistenceScope ? { expectedDecisionRevision: get().decisionRevision } : {}),
          decisions: [decision],
        });
        if (!isCurrentScope()) return result;
        if (result.decisionRevision !== undefined && decisionPersistenceScope) {
          get().recordDecisionRevision(
            teamName,
            decisionPersistenceScope.scopeKey,
            decisionPersistenceScope.scopeToken,
            result.decisionRevision
          );
        }
        if (result.errors.length > 0) {
          set({ applyError: result.errors.map((entry) => entry.error).join('\n') });
          recordReviewApplyEnd({
            success: false,
            decision: 'single_file',
            filesCount: 1,
            acceptedCount,
            rejectedCount,
            durationMs: elapsedMsSince(applyStartedAtMs),
            errorClass: result.conflicts > 0 ? 'validation' : 'unknown',
          });
          return result;
        }
        recordReviewApplyEnd({
          success: true,
          decision: 'single_file',
          filesCount: 1,
          acceptedCount,
          rejectedCount,
          durationMs: elapsedMsSince(applyStartedAtMs),
          errorClass: 'none',
        });
        return result;
      } catch (error) {
        recordReviewApplyEnd({
          success: false,
          decision: 'single_file',
          filesCount: 1,
          acceptedCount,
          rejectedCount,
          durationMs: elapsedMsSince(applyStartedAtMs),
          errorClass: classifyAnalyticsError(error),
        });
        logger.error('applySingleFileDecision error:', error);
        if (isCurrentScope()) {
          set({ applyError: mapReviewError(error) });
        }
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

        const aliases = new Set([filePath, existing.filePath]);
        const addMatchingAliases = (record: Record<string, unknown>): void => {
          for (const key of Object.keys(record)) {
            if (reviewPathsEqual(key, filePath) || reviewPathsEqual(key, existing.filePath)) {
              aliases.add(key);
            }
          }
        };
        addMatchingAliases(s.fileChunkCounts);
        addMatchingAliases(s.fileContents);
        addMatchingAliases(s.fileContentsLoading);
        addMatchingAliases(s.editedContents);
        addMatchingAliases(s.reviewExternalChangesByFile);
        addMatchingAliases(s.fileContentVersionByPath);

        const nextHunkDecisions = { ...s.hunkDecisions };
        const reviewKey = getReviewKeyForFilePath(s.activeChangeSet.files, filePath);
        const prefix = `${reviewKey}:`;
        for (const key of Object.keys(nextHunkDecisions)) {
          if (key.startsWith(prefix)) delete nextHunkDecisions[key];
        }

        const nextFileDecisions = { ...s.fileDecisions };
        delete nextFileDecisions[reviewKey];

        const nextFileChunkCounts = { ...s.fileChunkCounts };
        for (const alias of aliases) delete nextFileChunkCounts[alias];

        const nextFileContents = { ...s.fileContents };
        for (const alias of aliases) delete nextFileContents[alias];

        const nextFileContentsLoading = { ...s.fileContentsLoading };
        for (const alias of aliases) delete nextFileContentsLoading[alias];

        const nextEditedContents = { ...s.editedContents };
        for (const alias of aliases) delete nextEditedContents[alias];

        const nextHashes = { ...s.hunkContextHashesByFile };
        delete nextHashes[reviewKey];
        for (const alias of aliases) delete nextHashes[alias];

        const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
        for (const alias of aliases) delete nextReviewExternalChangesByFile[alias];

        const nextFileContentVersionByPath = { ...s.fileContentVersionByPath };
        for (const alias of aliases) {
          nextFileContentVersionByPath[alias] = (s.fileContentVersionByPath[alias] ?? 0) + 1;
        }

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
          if (key.startsWith(prefix)) delete nextHunkDecisions[key];
        }

        const nextFileDecisions = { ...s.fileDecisions };
        delete nextFileDecisions[reviewKey];

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

    saveEditedFile: async (
      filePath: string,
      scope: ReviewFileScope,
      expectedCurrentContent: string | null
    ) => {
      const state = get();
      const changeSetEpoch = state.changeSetEpoch;
      const scopeFingerprint = getReviewChangeSetIdentityToken(state.activeChangeSet);
      const fileEntry = findReviewFileByPath(state.activeChangeSet?.files, filePath);
      const canonicalFilePath = fileEntry?.filePath ?? filePath;
      const hasRequestedDraft = filePath in state.editedContents;
      const hasCanonicalDraft = canonicalFilePath in state.editedContents;
      const content = hasRequestedDraft
        ? state.editedContents[filePath]
        : state.editedContents[canonicalFilePath];
      if (!hasRequestedDraft && !hasCanonicalDraft)
        return { ok: false, error: 'The edited draft is no longer available.' };
      set((s) => ({
        fileContentsLoading: {
          ...s.fileContentsLoading,
          [filePath]: false,
          [canonicalFilePath]: false,
        },
        applying: true,
        applyError: null,
        fileContentVersionByPath: {
          ...s.fileContentVersionByPath,
          [filePath]: (s.fileContentVersionByPath[filePath] ?? 0) + 1,
          [canonicalFilePath]: (s.fileContentVersionByPath[canonicalFilePath] ?? 0) + 1,
        },
      }));
      try {
        await api.review.saveEditedFile(scope, canonicalFilePath, content, expectedCurrentContent);
        set((s) => {
          if (
            s.changeSetEpoch !== changeSetEpoch ||
            getReviewChangeSetIdentityToken(s.activeChangeSet) !== scopeFingerprint
          ) {
            return s;
          }
          const aliases = new Set([filePath, canonicalFilePath]);
          addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.editedContents);
          addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileChunkCounts);
          addMatchingReviewPathAliases(
            aliases,
            filePath,
            canonicalFilePath,
            s.hunkContextHashesByFile
          );
          addMatchingReviewPathAliases(
            aliases,
            filePath,
            canonicalFilePath,
            s.reviewExternalChangesByFile
          );
          addMatchingReviewPathAliases(aliases, filePath, canonicalFilePath, s.fileContents);

          const nextEdited = { ...s.editedContents };
          const currentDraft = s.editedContents[filePath] ?? s.editedContents[canonicalFilePath];
          const draftStillMatchesSavedContent = currentDraft === content;
          if (draftStillMatchesSavedContent) for (const alias of aliases) delete nextEdited[alias];
          const nextFileChunkCounts = { ...s.fileChunkCounts };
          for (const alias of aliases) delete nextFileChunkCounts[alias];
          const nextHunkContextHashesByFile = { ...s.hunkContextHashesByFile };
          const reviewKey = getReviewKeyForFilePath(s.activeChangeSet?.files, canonicalFilePath);
          delete nextHunkContextHashesByFile[reviewKey];
          for (const alias of aliases) delete nextHunkContextHashesByFile[alias];
          const decisionPrefixes = new Set([reviewKey, ...aliases].map((key) => `${key}:`));
          const nextHunkDecisions = { ...s.hunkDecisions };
          for (const key of Object.keys(nextHunkDecisions)) {
            if ([...decisionPrefixes].some((prefix) => key.startsWith(prefix))) {
              delete nextHunkDecisions[key];
            }
          }
          const nextFileDecisions = { ...s.fileDecisions };
          delete nextFileDecisions[reviewKey];
          for (const alias of aliases) delete nextFileDecisions[alias];
          const nextReviewExternalChangesByFile = { ...s.reviewExternalChangesByFile };
          for (const alias of aliases) delete nextReviewExternalChangesByFile[alias];

          const nextContents = { ...s.fileContents };
          const existing = nextContents[canonicalFilePath] ?? nextContents[filePath];
          for (const alias of aliases) {
            if (alias !== canonicalFilePath) delete nextContents[alias];
          }
          if (existing) {
            nextContents[canonicalFilePath] = {
              ...existing,
              filePath: canonicalFilePath,
              modifiedFullContent: content,
              contentSource: 'disk-current',
            };
          }
          return {
            editedContents: nextEdited,
            fileChunkCounts: nextFileChunkCounts,
            hunkContextHashesByFile: nextHunkContextHashesByFile,
            hunkDecisions: nextHunkDecisions,
            fileDecisions: nextFileDecisions,
            fileContents: nextContents,
            reviewExternalChangesByFile: nextReviewExternalChangesByFile,
            applying: false,
          };
        });
        return { ok: true };
      } catch (error) {
        const errorMessage = mapReviewError(error);
        const latest = get();
        if (
          latest.changeSetEpoch === changeSetEpoch &&
          getReviewChangeSetIdentityToken(latest.activeChangeSet) === scopeFingerprint
        ) {
          set({ applying: false, applyError: errorMessage });
        }
        return { ok: false, error: errorMessage };
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
      if (summaryCacheable && cachedPresence === 'has_changes') {
        get().setSelectedTeamTaskChangePresence(teamName, taskId, cachedPresence);
        return;
      }
      if (summaryCacheable && cachedPresence === 'needs_attention') {
        get().setSelectedTeamTaskChangePresence(teamName, taskId, cachedPresence);
        const lastRevalidationMs = taskChangesNeedsAttentionRevalidationTs.get(cacheKey) ?? 0;
        if (Date.now() - lastRevalidationMs >= NEEDS_ATTENTION_REVALIDATION_TTL) {
          taskChangesNeedsAttentionRevalidationTs.set(cacheKey, Date.now());
          void revalidateTaskChangePresence(teamName, taskId, options);
        }
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
          set((s) => ({
            taskChangePresenceByKey: applyTaskChangePresenceCacheUpdate(
              s.taskChangePresenceByKey,
              cacheKey,
              nextPresence
            ),
          }));
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
          taskChangesNeedsAttentionRevalidationTs.delete(key);
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
