import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

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
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  diffViewMode: 'unified' | 'split';
  collapseUnchanged: boolean;
  applyError: string | null;
  applying: boolean;

  // Editable diff state
  editedContents: Record<string, string>;

  // Phase 1 actions
  fetchAgentChanges: (teamName: string, memberName: string) => Promise<void>;
  fetchTaskChanges: (teamName: string, taskId: string) => Promise<void>;
  selectReviewFile: (filePath: string | null) => void;
  clearChangeReview: () => void;
  fetchChangeStats: (teamName: string, memberName: string) => Promise<void>;

  // Phase 2 actions
  setHunkDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => void;
  setFileDecision: (filePath: string, decision: HunkDecision) => void;
  acceptAllFile: (filePath: string) => void;
  rejectAllFile: (filePath: string) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  setDiffViewMode: (mode: 'unified' | 'split') => void;
  setCollapseUnchanged: (collapse: boolean) => void;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  applyReview: (teamName: string, taskId?: string, memberName?: string) => Promise<void>;
  invalidateChangeStats: (teamName: string) => void;

  // Editable diff actions
  updateEditedContent: (filePath: string, content: string) => void;
  discardFileEdits: (filePath: string) => void;
  discardAllEdits: () => void;
  saveEditedFile: (filePath: string) => Promise<void>;
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
  fileContents: {},
  fileContentsLoading: {},
  diffViewMode: 'unified',
  collapseUnchanged: true,
  applyError: null,
  applying: false,

  // Editable diff initial state
  editedContents: {},

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
      set({
        activeChangeSet: data,
        changeSetLoading: false,
        selectedReviewFilePath: data.files[0]?.filePath ?? null,
      });
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
      fileContents: {},
      fileContentsLoading: {},
      applyError: null,
      applying: false,
      editedContents: {},
    });
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
    const key = `${filePath}:${hunkIndex}`;
    set((state) => ({
      hunkDecisions: { ...state.hunkDecisions, [key]: decision },
    }));
  },

  setFileDecision: (filePath: string, decision: HunkDecision) => {
    set((state) => ({
      fileDecisions: { ...state.fileDecisions, [filePath]: decision },
    }));
  },

  acceptAllFile: (filePath: string) => {
    const state = get();
    const file = state.activeChangeSet?.files.find((f) => f.filePath === filePath);
    if (!file) return;

    const newHunkDecisions = { ...state.hunkDecisions };
    for (let i = 0; i < file.snippets.length; i++) {
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

    const newHunkDecisions = { ...state.hunkDecisions };
    for (let i = 0; i < file.snippets.length; i++) {
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
      for (let i = 0; i < file.snippets.length; i++) {
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
      for (let i = 0; i < file.snippets.length; i++) {
        newHunkDecisions[`${file.filePath}:${i}`] = 'rejected';
      }
    }
    set({ hunkDecisions: newHunkDecisions, fileDecisions: newFileDecisions });
  },

  setDiffViewMode: (mode: 'unified' | 'split') => {
    set({ diffViewMode: mode });
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
      const content = await api.review.getFileContent(teamName, memberName, filePath);
      set((s) => ({
        fileContents: { ...s.fileContents, [filePath]: content },
        fileContentsLoading: { ...s.fileContentsLoading, [filePath]: false },
      }));
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
      const fingerprint = (cs: {
        totalFiles: number;
        totalLinesAdded: number;
        totalLinesRemoved: number;
        files: { filePath: string }[];
      }) =>
        `${cs.totalFiles}:${cs.totalLinesAdded}:${cs.totalLinesRemoved}:${cs.files.map((f) => f.filePath).join(',')}`;

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
      const { hunkDecisions, fileDecisions, activeChangeSet } = get();
      if (!activeChangeSet) {
        set({ applying: false });
        return;
      }

      const decisions: FileReviewDecision[] = [];

      for (const file of activeChangeSet.files) {
        const fileDecision = fileDecisions[file.filePath] ?? 'pending';
        const hunkDecs: Record<number, HunkDecision> = {};

        for (let i = 0; i < file.snippets.length; i++) {
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
        const next = { ...s.editedContents };
        delete next[filePath];
        return { editedContents: next, applying: false };
      });
    } catch (error) {
      set({ applying: false, applyError: mapReviewError(error) });
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
