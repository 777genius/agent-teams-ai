import {
  applyTaskDetailCompact,
  applyTaskDetailReadStart,
  beginTaskDetailSave,
  beginTaskDetailSubmit,
  claimTaskDetailOwner,
  commitTaskDetailFull,
  completeTaskDetailSave,
  completeTaskDetailSubmit,
  createTaskDetailReadEntry,
  EMPTY_TASK_DETAIL_SESSION,
  invalidateTaskDetailFull,
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
  type OpenTaskDetailTabResult,
  releaseTaskDetailOwner,
  type TaskDetailEditPart,
  type TaskDetailIdentity,
  taskDetailKey,
  type TaskDetailReadEntry,
  type TaskDetailReadToken,
  type TaskDetailSavePart,
  type TaskDetailSaveRevision,
  type TaskDetailSession,
  touchTaskDetailPart,
  transferTaskDetailOwner,
} from '@features/team-task-detail/renderer';
import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import {
  captureTaskDetailReadScope,
  invalidateTeamSnapshotResource,
  invalidateTeamTaskFullResource,
  isTaskDetailReadScopeCurrent,
  isTaskDetailTokenCurrent,
  readTeamTaskFullResource,
} from '../team/taskDetailReadAuthority';

import type { AppState } from '../types';
import type { TeamTaskWithKanban } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface TeamTaskDetailSlice {
  taskDetailById: Record<string, TaskDetailReadEntry>;
  taskDetailSessionById: Record<string, TaskDetailSession>;
  ensureTaskDetail: (identity: TaskDetailIdentity) => Promise<void>;
  applyTaskDetailSnapshot: (
    contextId: string,
    teamName: string,
    tasks: readonly TeamTaskWithKanban[],
    snapshotToken: TaskDetailReadToken
  ) => void;
  invalidateTaskDetailSource: (identity?: TaskDetailIdentity) => void;
  invalidateTaskDetailTeamSource: (contextId: string, teamName: string, taskId?: string) => void;
  clearTaskDetailTeamWork: (contextId: string, teamName: string) => void;
  updateTaskDetailSession: (
    identity: TaskDetailIdentity,
    update: Partial<TaskDetailSession>
  ) => void;
  updateTaskDetailSessionPart: (
    identity: TaskDetailIdentity,
    part: TaskDetailEditPart,
    value: string | string[] | unknown[] | TaskDetailSession['reply']
  ) => void;
  beginTaskDetailSubmitSession: (identity: TaskDetailIdentity) => number;
  completeTaskDetailSubmitSession: (identity: TaskDetailIdentity, revision: number) => void;
  beginTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    parts: readonly TaskDetailSavePart[]
  ) => TaskDetailSaveRevision;
  completeTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    revision: TaskDetailSaveRevision
  ) => void;
  claimTaskDetailOwner: (identity: TaskDetailIdentity, surfaceId: string) => void;
  transferTaskDetailOwner: (
    identity: TaskDetailIdentity,
    fromSurfaceId: string,
    toSurfaceId: string,
    expectedOwnerRevision: number
  ) => void;
  releaseTaskDetailOwner: (
    identity: TaskDetailIdentity,
    surfaceId: string,
    expectedOwnerRevision: number
  ) => void;
  openTaskDetailTab: (identity: TaskDetailIdentity) => OpenTaskDetailTabResult | null;
}

export const createTeamTaskDetailSlice: StateCreator<AppState, [], [], TeamTaskDetailSlice> = (
  set,
  get
) => ({
  taskDetailById: {},
  taskDetailSessionById: {},

  ensureTaskDetail: async (rawIdentity) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return;
    if (identity.contextId !== get().activeContextId) return;
    const key = taskDetailKey(identity);
    const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
    set((state) => {
      const current = state.taskDetailById[key] ?? createTaskDetailReadEntry(identity);
      return {
        taskDetailById: {
          ...state.taskDetailById,
          [key]: { ...current, loading: true, refreshPending: false },
        },
      };
    });

    try {
      await get().refreshTeamData(identity.teamName, { withDedup: true });
    } catch {
      // Full task state classifies the terminal result below.
    } finally {
      if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) return;
    }
    const beforeRead = get().taskDetailById[key];
    if (!beforeRead) return;

    const handle = readTeamTaskFullResource(identity, scope, async () => {
      if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) {
        throw new Error('stale task detail scope');
      }
      return unwrapIpc('team:getTask', () => api.teams.getTask(identity.teamName, identity.taskId));
    });
    set((state) => {
      const current = state.taskDetailById[key];
      if (!current) return state;
      return {
        taskDetailById: {
          ...state.taskDetailById,
          [key]: applyTaskDetailReadStart(current, {
            ...handle.token,
          }),
        },
      };
    });
    try {
      const result = await handle.result;
      if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) return;
      if (!isTaskDetailTokenCurrent(handle.token, scope)) return;
      set((state) => {
        const current = state.taskDetailById[key];
        if (!current) return state;
        return {
          taskDetailById: {
            ...state.taskDetailById,
            [key]: commitTaskDetailFull(current, handle.token, result.value ?? null, result.error),
          },
        };
      });
    } catch {
      if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) return;
      if (!isTaskDetailTokenCurrent(handle.token, scope)) return;
    }
  },

  applyTaskDetailSnapshot: (contextId, teamName, tasks, snapshotToken) => {
    set((state) => {
      const next = { ...state.taskDetailById };
      let changed = false;
      for (const [key, entry] of Object.entries(next)) {
        if (entry.identity.contextId !== contextId) continue;
        if (entry.identity.teamName !== teamName) continue;
        const compact = tasks.find((task) => task.id === entry.identity.taskId);
        const merged = applyTaskDetailCompact(entry, compact, snapshotToken);
        if (merged !== entry) {
          next[key] = merged;
          changed = true;
        }
      }
      return changed ? { taskDetailById: next } : {};
    });
  },

  invalidateTaskDetailSource: (rawIdentity) => {
    if (!rawIdentity) return;
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return;
    invalidateTeamSnapshotResource(identity.contextId, identity.teamName);
    invalidateTeamTaskFullResource(identity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailById[key];
      if (!current) return state;
      return {
        taskDetailById: {
          ...state.taskDetailById,
          [key]: invalidateTaskDetailFull(current),
        },
      };
    });
  },

  invalidateTaskDetailTeamSource: (contextId, teamName, taskId) => {
    invalidateTeamSnapshotResource(contextId, teamName);
    const affected = Object.values(get().taskDetailById).filter(
      (entry) =>
        entry.identity.contextId === contextId &&
        entry.identity.teamName === teamName &&
        (!taskId || entry.identity.taskId === taskId)
    );
    for (const entry of affected) invalidateTeamTaskFullResource(entry.identity);
    set((state) => {
      const next = { ...state.taskDetailById };
      let changed = false;
      for (const [key, entry] of Object.entries(next)) {
        if (entry.identity.contextId !== contextId) continue;
        if (entry.identity.teamName !== teamName) continue;
        if (taskId && entry.identity.taskId !== taskId) continue;
        next[key] = invalidateTaskDetailFull(entry);
        changed = true;
      }
      return changed ? { taskDetailById: next } : {};
    });
  },

  clearTaskDetailTeamWork: (contextId, teamName) => {
    set((state) => {
      const nextDetails = { ...state.taskDetailById };
      const nextSessions = { ...state.taskDetailSessionById };
      for (const [key, entry] of Object.entries(nextDetails)) {
        if (entry.identity.contextId === contextId && entry.identity.teamName === teamName) {
          delete nextDetails[key];
          delete nextSessions[key];
        }
      }
      return { taskDetailById: nextDetails, taskDetailSessionById: nextSessions };
    });
  },

  updateTaskDetailSession: (rawIdentity, update) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      let next = state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION;
      next = { ...next, ...update };
      for (const part of [
        'commentText',
        'commentChips',
        'pendingAttachments',
        'reply',
        'subject',
        'description',
      ] as const) {
        const field =
          part === 'subject' ? 'subjectDraft' : part === 'description' ? 'descriptionDraft' : part;
        if (field in update) next = touchTaskDetailPart(next, part);
      }
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: next,
        },
      };
    });
  },

  updateTaskDetailSessionPart: (rawIdentity, part, value) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION;
      const next = { ...touchTaskDetailPart(current, part) };
      if (part === 'commentText') next.commentText = String(value);
      if (part === 'commentChips') next.commentChips = [...(value as string[])];
      if (part === 'pendingAttachments') next.pendingAttachments = [...(value as unknown[])];
      if (part === 'reply') next.reply = value as TaskDetailSession['reply'];
      if (part === 'subject') next.subjectDraft = String(value);
      if (part === 'description') next.descriptionDraft = String(value);
      return {
        taskDetailSessionById: { ...state.taskDetailSessionById, [key]: next },
      };
    });
  },

  beginTaskDetailSubmitSession: (rawIdentity) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    let revision = 0;
    set((state) => {
      const current = state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION;
      const next = beginTaskDetailSubmit(current, current);
      revision = next.submitRevision;
      return { taskDetailSessionById: { ...state.taskDetailSessionById, [key]: next } };
    });
    return revision;
  },

  completeTaskDetailSubmitSession: (rawIdentity, revision) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: completeTaskDetailSubmit(current, revision),
        },
      };
    });
  },

  beginTaskDetailSaveSession: (rawIdentity, parts) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION;
      const next = beginTaskDetailSave(current, parts);
      return { taskDetailSessionById: { ...state.taskDetailSessionById, [key]: next } };
    });
    return Object.fromEntries(
      parts.map((part) => [part, get().taskDetailSessionById[key].saveRevisionByPart[part]])
    ) as TaskDetailSaveRevision;
  },

  completeTaskDetailSaveSession: (rawIdentity, revision) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: completeTaskDetailSave(current, revision),
        },
      };
    });
  },

  claimTaskDetailOwner: (rawIdentity, surfaceId) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => ({
      taskDetailSessionById: {
        ...state.taskDetailSessionById,
        [key]: claimTaskDetailOwner(
          state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION,
          surfaceId
        ),
      },
    }));
  },

  transferTaskDetailOwner: (rawIdentity, fromSurfaceId, toSurfaceId, expectedOwnerRevision) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => ({
      taskDetailSessionById: {
        ...state.taskDetailSessionById,
        [key]: transferTaskDetailOwner(
          state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION,
          fromSurfaceId,
          toSurfaceId,
          expectedOwnerRevision
        ),
      },
    }));
  },

  releaseTaskDetailOwner: (rawIdentity, surfaceId, expectedOwnerRevision) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => ({
      taskDetailSessionById: {
        ...state.taskDetailSessionById,
        [key]: releaseTaskDetailOwner(
          state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION,
          surfaceId,
          expectedOwnerRevision
        ),
      },
    }));
  },

  openTaskDetailTab: (rawIdentity) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return null;
    const state = get();
    const allTabs = state.getAllPaneTabs();
    const existing = allTabs.find(
      (tab) =>
        tab.type === 'team' &&
        tab.teamName === identity.teamName &&
        tab.taskDetail?.contextId === identity.contextId &&
        tab.taskDetail.taskId === identity.taskId
    );
    if (existing) {
      state.setActiveTab(existing.id);
      const paneId =
        state.paneLayout.panes.find((pane) => pane.tabs.some((tab) => tab.id === existing.id))
          ?.id ?? state.paneLayout.focusedPaneId;
      return { tabId: existing.id, paneId, created: false };
    }

    state.openTab({
      type: 'team',
      teamName: identity.teamName,
      taskDetail: { contextId: identity.contextId, taskId: identity.taskId },
      label: `${identity.teamName} #${identity.taskId}`,
    });

    const opened = get()
      .getAllPaneTabs()
      .find(
        (tab) =>
          tab.type === 'team' &&
          tab.teamName === identity.teamName &&
          tab.taskDetail?.contextId === identity.contextId &&
          tab.taskDetail.taskId === identity.taskId
      );
    if (!opened) return null;
    const paneId =
      get().paneLayout.panes.find((pane) => pane.tabs.some((tab) => tab.id === opened.id))?.id ??
      get().paneLayout.focusedPaneId;
    return { tabId: opened.id, paneId, created: true };
  },
});
