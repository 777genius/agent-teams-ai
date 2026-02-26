import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

/** Tracks in-flight checkTaskHasChanges calls to avoid duplicate requests */
const taskChangesCheckInFlight = new Set<string>();
/** Negative results cached with timestamp — recheck after 30s */
const taskChangesNegativeCache = new Map<string, number>();
const NEGATIVE_CACHE_TTL = 30_000;

/** Debounce timer for persisting decisions to disk */
let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

import type { AppState } from '../types';
import type {
  AgentChangeSet,
  ApplyReviewRequest,
  ChangeStats,
  FileChangeWithContent,
  FileReviewDecision,
  HunkDecision,
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

export interface ChangeReviewSlice {
  // Phase 1 state
  activeChangeSet: AgentChangeSet | TaskChangeSet | TaskChangeSetV2 | null;
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
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  collapseUnchanged: boolean;
  applyError: string | null;
  applying: boolean;

  // Editable diff state
  editedContents: Record<string, string>;

  /** Cache: "teamName:taskId" → true/false (has file changes) */
  taskHasChanges: Record<string, boolean>;

  // Phase 1 actions
  fetchAgentChanges: (teamName: string, memberName: string) => Promise<void>;
  fetchTaskChanges: (teamName: string, taskId: string) => Promise<void>;
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
  setHunkDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => void;
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
  ) => Promise<void>;
  invalidateChangeStats: (teamName: string) => void;

  // Editable diff actions
  updateEditedContent: (filePath: string, content: string) => void;
  discardFileEdits: (filePath: string) => void;
  discardAllEdits: () => void;
  saveEditedFile: (filePath: string) => Promise<void>;

  // Task change availability
  checkTaskHasChanges: (teamName: string, taskId: string) => Promise<void>;
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

export const createChangeReviewSlice: StateCreator<AppState, [], [], ChangeReviewSlice> = (
  set,
  get
) => ({
  // Phase 1 initial state
  activeChangeSet: null,
  changeSetLoading: false,
  changeSetError: null,
  selectedReviewFilePath: null,
  changeStatsCache: {},

  // Phase 2 initial state
  hunkDecisions: {},
  fileDecisions: {},
  fileChunkCounts: {},
  reviewUndoStack: [],
  fileContents: {},
  fileContentsLoading: {},
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
      set({
        activeChangeSet: data,
        changeSetLoading: false,
        selectedReviewFilePath: data.files[0]?.filePath ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch agent changes';
      logger.error('fetchAgentChanges error:', message);
      set({ changeSetError: message, changeSetLoading: false });
    }
  },

  fetchTaskChanges: async (teamName: string, taskId: string) => {
    set({ changeSetLoading: true, changeSetError: null });
    try {
      const data = await api.review.getTaskChanges(teamName, taskId);
      const cacheKey = `${teamName}:${taskId}`;
      set((s) => ({
        activeChangeSet: data,
        changeSetLoading: false,
        selectedReviewFilePath: data.files[0]?.filePath ?? null,
        taskHasChanges: { ...s.taskHasChanges, [cacheKey]: data.files.length > 0 },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch task changes';
      logger.error('fetchTaskChanges error:', message);
      set({ changeSetError: message, changeSetLoading: false });
    }
  },

  selectReviewFile: (filePath: string | null) => {
    set({ selectedReviewFilePath: filePath });
  },

  clearChangeReview: () => {
    set({
      activeChangeSet: null,
      changeSetLoading: false,
      changeSetError: null,
      selectedReviewFilePath: null,
      hunkDecisions: {},
      fileDecisions: {},
      fileChunkCounts: {},
      reviewUndoStack: [],
      fileContents: {},
      fileContentsLoading: {},
      applyError: null,
      applying: false,
      editedContents: {},
    });
  },

  clearChangeReviewCache: () => {
    set({
      activeChangeSet: null,
      changeSetLoading: false,
      changeSetError: null,
      selectedReviewFilePath: null,
      fileChunkCounts: {},
      reviewUndoStack: [],
      fileContents: {},
      fileContentsLoading: {},
      applyError: null,
      applying: false,
      editedContents: {},
    });
  },

  resetAllReviewState: () => {
    set({
      activeChangeSet: null,
      changeSetLoading: false,
      changeSetError: null,
      selectedReviewFilePath: null,
      hunkDecisions: {},
      fileDecisions: {},
      fileChunkCounts: {},
      reviewUndoStack: [],
      fileContents: {},
      fileContentsLoading: {},
      applyError: null,
      applying: false,
      editedContents: {},
    });
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
      const { hunkDecisions, fileDecisions } = get();
      void api.review.saveDecisions(teamName, scopeKey, hunkDecisions, fileDecisions);
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

  fetchFileContent: async (teamName: string, memberName: string | undefined, filePath: string) => {
    const state = get();
    // Skip if already loaded or loading
    if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;

    set((s) => ({
      fileContentsLoading: { ...s.fileContentsLoading, [filePath]: true },
    }));

    try {
      // Lookup snippets from activeChangeSet so backend can use them for reconstruction
      const activeChangeSet = get().activeChangeSet;
      const fileEntry = activeChangeSet?.files.find((f) => f.filePath === filePath);
      const snippets = fileEntry?.snippets ?? [];

      const content = await api.review.getFileContent(teamName, memberName, filePath, snippets);
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
      // Fingerprint uses file count + file paths only (not line counts)
      // because line counts may be corrected by lazy-loaded content resolution
      const fingerprint = (cs: { totalFiles: number; files: { filePath: string }[] }): string =>
        `${cs.totalFiles}:${cs.files.map((f) => f.filePath).join(',')}`;

      if (memberName && current) {
        const fresh = await api.review.getAgentChanges(teamName, memberName);
        if (fingerprint(fresh) !== fingerprint(current)) {
          set({
            activeChangeSet: fresh,
            applying: false,
            applyError: 'Changes have been updated since you started reviewing. Please re-review.',
          });
          return;
        }
      } else if (taskId && current) {
        const fresh = await api.review.getTaskChanges(teamName, taskId);
        if (fingerprint(fresh) !== fingerprint(current)) {
          set({
            activeChangeSet: fresh,
            applying: false,
            applyError: 'Changes have been updated since you started reviewing. Please re-review.',
          });
          return;
        }
      }

      // Build FileReviewDecision[] from hunkDecisions/fileDecisions
      const { hunkDecisions, fileDecisions, fileChunkCounts, activeChangeSet } = get();
      if (!activeChangeSet) {
        set({ applying: false });
        return;
      }

      const decisions: FileReviewDecision[] = [];

      for (const file of activeChangeSet.files) {
        const fileDecision = fileDecisions[file.filePath] ?? 'pending';
        const hunkDecs: Record<number, HunkDecision> = {};

        const count = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
        for (let i = 0; i < count; i++) {
          const key = `${file.filePath}:${i}`;
          hunkDecs[i] = hunkDecisions[key] ?? 'pending';
        }

        // Only include files that have at least one rejected hunk
        const hasRejected =
          fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
        if (hasRejected) {
          decisions.push({
            filePath: file.filePath,
            fileDecision,
            hunkDecisions: hunkDecs,
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
    const { hunkDecisions, fileDecisions, fileChunkCounts, activeChangeSet } = get();
    if (!activeChangeSet) return;

    const file = activeChangeSet.files.find((f) => f.filePath === filePath);
    if (!file) return;

    const fileDecision = fileDecisions[filePath] ?? 'pending';
    const hunkDecs: Record<number, HunkDecision> = {};
    const count = getFileHunkCount(filePath, file.snippets.length, fileChunkCounts);
    for (let i = 0; i < count; i++) {
      hunkDecs[i] = hunkDecisions[`${filePath}:${i}`] ?? 'pending';
    }

    const hasRejected =
      fileDecision === 'rejected' || Object.values(hunkDecs).some((d) => d === 'rejected');
    if (!hasRejected) return;

    try {
      await api.review.applyDecisions({
        teamName,
        taskId,
        memberName,
        decisions: [{ filePath, fileDecision, hunkDecisions: hunkDecs }],
      });
    } catch (error) {
      logger.error('applySingleFileDecision error:', error);
      set({ applyError: mapReviewError(error) });
    }
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

  saveEditedFile: async (filePath: string) => {
    const content = get().editedContents[filePath];
    if (!(filePath in get().editedContents)) return;
    set({ applying: true, applyError: null });
    try {
      await api.review.saveEditedFile(filePath, content);
      set((s) => {
        const nextEdited = { ...s.editedContents };
        delete nextEdited[filePath];
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
        return { editedContents: nextEdited, fileContents: nextContents, applying: false };
      });
    } catch (error) {
      set({ applying: false, applyError: mapReviewError(error) });
    }
  },

  checkTaskHasChanges: async (teamName: string, taskId: string) => {
    const cacheKey = `${teamName}:${taskId}`;
    // Positive results are final — no need to recheck
    if (get().taskHasChanges[cacheKey] === true) return;
    // Prevent duplicate in-flight requests
    if (taskChangesCheckInFlight.has(cacheKey)) return;
    // Negative results cached with TTL — avoid API spam for tasks that truly have no changes
    const negativeTs = taskChangesNegativeCache.get(cacheKey);
    if (negativeTs && Date.now() - negativeTs < NEGATIVE_CACHE_TTL) return;

    taskChangesCheckInFlight.add(cacheKey);
    try {
      const data = await api.review.getTaskChanges(teamName, taskId);
      if (data.files.length > 0) {
        set((s) => ({
          taskHasChanges: { ...s.taskHasChanges, [cacheKey]: true },
        }));
        taskChangesNegativeCache.delete(cacheKey);
      } else {
        taskChangesNegativeCache.set(cacheKey, Date.now());
      }
    } catch {
      // Don't cache errors in store — allow retry when session data appears later
      taskChangesNegativeCache.set(cacheKey, Date.now());
    } finally {
      taskChangesCheckInFlight.delete(cacheKey);
    }
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
});
