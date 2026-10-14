import {
  applyTaskDetailCompact,
  applyTaskDetailReadStart,
  beginTaskDetailPendingAttachment,
  beginTaskDetailSave,
  beginTaskDetailSubmit,
  claimTaskDetailOwner,
  commitTaskDetailFull,
  completeTaskDetailPendingAttachment,
  completeTaskDetailSave,
  completeTaskDetailSubmit,
  createTaskDetailReadEntry,
  EMPTY_TASK_DETAIL_SESSION,
  failTaskDetailSave,
  failTaskDetailSubmit,
  hydrateTaskDetailDraft,
  ignoreTaskDetailPendingAttachment,
  invalidateTaskDetailFull,
  isValidTaskDetailIdentity,
  markTaskDetailTeamUnavailable,
  normalizeTaskDetailIdentity,
  type OpenTaskDetailTabResult,
  releaseTaskDetailOwner,
  retireTaskDetailSessionWork,
  setTaskDetailDeletionIntent,
  type TaskDetailDeletionIntent,
  type TaskDetailEditPart,
  type TaskDetailIdentity,
  taskDetailKey,
  type TaskDetailReadEntry,
  type TaskDetailReadScope,
  type TaskDetailReadToken,
  type TaskDetailSavePart,
  type TaskDetailSaveRevision,
  type TaskDetailSession,
  touchTaskDetailPart,
  transferTaskDetailOwner,
} from '@features/team-task-detail/core';
import { api } from '@renderer/api';
import { isTaskDetailTab } from '@renderer/types/tabs';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';

import {
  queueTaskDetailEditor,
  type TaskDetailEditorIntent,
  type TaskDetailEditorRequest,
} from '../team/taskDetailEditorRoute';
import {
  captureTaskDetailReadScope,
  invalidateTeamSnapshotResource,
  invalidateTeamTaskFullResource,
  isTaskDetailReadScopeCurrent,
  isTaskDetailTokenCurrent,
  readTeamTaskFullResource,
} from '../team/taskDetailReadAuthority';
import { hasTaskDetailReadInterest } from '../team/taskDetailReadInterest';
import { queueTaskDetailReview } from '../team/taskDetailReviewRoute';

import type { TaskDetailReviewRequest } from '../team/taskDetailReviewRoute';
import type { AppState } from '../types';
import type { TeamTaskWithKanban } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface TeamTaskDetailSlice {
  taskDetailReviewActivationFailure: {
    nonce: string;
    identity: TaskDetailIdentity;
    options: Pick<TaskDetailReviewRequest, 'filePath' | 'requestOptions'>;
  } | null;
  closeTaskDetailReviewActivationFailure: (nonce: string) => void;
  retryTaskDetailReviewActivationFailure: (nonce: string) => boolean;
  retryPendingTaskDetailReview: (nonce: string) => boolean;
  closePendingTaskDetailReview: (nonce: string) => void;
  openTaskDetailReview: (
    identity: TaskDetailIdentity,
    options: Pick<TaskDetailReviewRequest, 'filePath' | 'requestOptions'>
  ) => boolean;
  taskDetailEditorActivationFailure: {
    nonce: string;
    identity: TaskDetailIdentity;
    intent: TaskDetailEditorIntent;
  } | null;
  pendingTaskDetailEditorRequest: TaskDetailEditorRequest | null;
  setPendingTaskDetailEditorRequest: (request: TaskDetailEditorRequest | null) => void;
  openTaskDetailEditor: (identity: TaskDetailIdentity, intent: TaskDetailEditorIntent) => boolean;
  retryPendingTaskDetailEditor: (nonce: string) => boolean;
  closePendingTaskDetailEditor: (nonce: string) => void;
  closeTaskDetailEditorActivationFailure: (nonce: string) => void;
  retryTaskDetailEditorActivationFailure: (nonce: string) => boolean;
  taskDetailById: Record<string, TaskDetailReadEntry>;
  taskDetailSessionById: Record<string, TaskDetailSession>;
  setTaskDetailDeletionIntent: (
    identity: TaskDetailIdentity,
    intent: TaskDetailDeletionIntent,
    requestScope: Omit<TaskDetailReadScope, 'teamName'>
  ) => boolean;
  taskDetailSurfaceInterests: Record<string, TaskDetailIdentity | null>;
  ensureTaskDetail: (identity: TaskDetailIdentity) => Promise<void>;
  setTaskDetailSurfaceInterest: (surfaceId: string, identity: TaskDetailIdentity | null) => void;
  applyTaskDetailSnapshot: (
    contextId: string,
    teamName: string,
    tasks: readonly TeamTaskWithKanban[],
    snapshotToken: TaskDetailReadToken
  ) => void;
  invalidateTaskDetailSource: (identity?: TaskDetailIdentity) => void;
  invalidateTaskDetailTeamSource: (contextId: string, teamName: string, taskId?: string) => void;
  clearTaskDetailTeamWork: (contextId: string, teamName: string) => void;
  retireTaskDetailSessionWork: (
    scope?: Pick<TaskDetailIdentity, 'contextId' | 'teamName'>,
    preservePendingAttachmentPreparation?: boolean
  ) => void;
  hydrateTaskDetailSessionDraft: (
    identity: TaskDetailIdentity,
    draft: { text?: string; commentChips?: TaskDetailSession['commentChips'] }
  ) => void;
  updateTaskDetailSession: (
    identity: TaskDetailIdentity,
    update: Partial<TaskDetailSession>
  ) => void;
  updateTaskDetailSessionPart: (
    identity: TaskDetailIdentity,
    part: TaskDetailEditPart,
    value: TaskDetailSession[
      | 'commentText'
      | 'commentChips'
      | 'pendingAttachments'
      | 'reply'
      | 'subjectDraft'
      | 'descriptionDraft']
  ) => void;
  beginTaskDetailSubmitSession: (identity: TaskDetailIdentity) => number;
  completeTaskDetailSubmitSession: (identity: TaskDetailIdentity, revision: number) => void;
  failTaskDetailSubmitSession: (
    identity: TaskDetailIdentity,
    revision: number,
    error: string
  ) => void;
  beginTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    parts: readonly TaskDetailSavePart[]
  ) => TaskDetailSaveRevision;
  completeTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    revision: TaskDetailSaveRevision
  ) => void;
  failTaskDetailSaveSession: (
    identity: TaskDetailIdentity,
    revision: TaskDetailSaveRevision,
    error: string
  ) => void;
  beginTaskDetailPendingAttachmentSession: (
    identity: TaskDetailIdentity,
    attachment: TaskDetailSession['pendingAttachments'][number]
  ) => void;
  completeTaskDetailPendingAttachmentSession: (
    identity: TaskDetailIdentity,
    id: string,
    attachment: TaskDetailSession['pendingAttachments'][number]
  ) => void;
  ignoreTaskDetailPendingAttachmentSession: (identity: TaskDetailIdentity, id: string) => void;
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
  taskDetailReviewActivationFailure: null,
  taskDetailEditorActivationFailure: null,
  pendingTaskDetailEditorRequest: null,
  setPendingTaskDetailEditorRequest: (request) => set({ pendingTaskDetailEditorRequest: request }),
  openTaskDetailEditor: (identity, intent) => {
    const accepted = queueTaskDetailEditor(get, identity, intent);
    if (accepted) set({ taskDetailEditorActivationFailure: null });
    else if (!get().isContextSwitching && get().activeContextId === identity.contextId)
      set({
        taskDetailEditorActivationFailure: { identity, intent, nonce: crypto.randomUUID() },
      });
    return accepted;
  },
  retryPendingTaskDetailEditor: (nonce) => {
    const request = get().pendingTaskDetailEditorRequest;
    if (
      !request ||
      request.nonce !== nonce ||
      get().isContextSwitching ||
      !isTaskDetailReadScopeCurrent(request, get().activeContextId, request.teamName)
    )
      return false;
    return queueTaskDetailEditor(
      get,
      { contextId: request.contextId, teamName: request.teamName },
      {
        projectPath: request.projectPath,
        filePath: request.filePath,
        line: request.line,
      }
    );
  },
  closePendingTaskDetailEditor: (nonce) => {
    const state = get();
    if (state.pendingTaskDetailEditorRequest?.nonce === nonce)
      state.setPendingTaskDetailEditorRequest(null);
  },
  retryTaskDetailEditorActivationFailure: (nonce) => {
    const state = get();
    const failure = state.taskDetailEditorActivationFailure;
    return failure?.nonce === nonce
      ? state.openTaskDetailEditor(failure.identity, failure.intent)
      : false;
  },
  closeTaskDetailEditorActivationFailure: (nonce) => {
    const failure = get().taskDetailEditorActivationFailure;
    if (failure?.nonce === nonce) set({ taskDetailEditorActivationFailure: null });
  },
  retryTaskDetailReviewActivationFailure: (nonce) => {
    const state = get();
    const failure = state.taskDetailReviewActivationFailure;
    return failure?.nonce === nonce
      ? state.openTaskDetailReview(failure.identity, failure.options)
      : false;
  },
  closeTaskDetailReviewActivationFailure: (nonce) => {
    const failure = get().taskDetailReviewActivationFailure;
    if (failure?.nonce === nonce) set({ taskDetailReviewActivationFailure: null });
  },
  retryPendingTaskDetailReview: (nonce) => {
    const request = get().pendingReviewRequest;
    if (!request || request.nonce !== nonce) return false;
    return queueTaskDetailReview(
      get,
      { contextId: request.contextId, teamName: request.teamName, taskId: request.taskId },
      { filePath: request.filePath, requestOptions: request.requestOptions }
    );
  },
  closePendingTaskDetailReview: (nonce) => {
    const state = get();
    const request = state.pendingReviewRequest;
    if (
      request?.nonce === nonce &&
      request.contextId === state.activeContextId &&
      !state.isContextSwitching
    )
      state.setPendingReviewRequest(null);
  },
  openTaskDetailReview: (rawIdentity, options) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const accepted = queueTaskDetailReview(get, identity, options);
    if (accepted) set({ taskDetailReviewActivationFailure: null });
    else if (
      isValidTaskDetailIdentity(identity) &&
      !get().isContextSwitching &&
      get().activeContextId === identity.contextId
    )
      set({ taskDetailReviewActivationFailure: { identity, options, nonce: crypto.randomUUID() } });
    return accepted;
  },
  taskDetailSessionById: {},
  taskDetailSurfaceInterests: {},

  setTaskDetailSurfaceInterest: (surfaceId, rawIdentity) => {
    const identity = rawIdentity ? normalizeTaskDetailIdentity(rawIdentity) : null;
    set((state) => {
      const current = state.taskDetailSurfaceInterests[surfaceId] ?? null;
      const next = identity && isValidTaskDetailIdentity(identity) ? identity : null;
      if (
        current === next ||
        (current &&
          next &&
          current.contextId === next.contextId &&
          current.teamName === next.teamName &&
          current.taskId === next.taskId)
      )
        return state;
      const interests = { ...state.taskDetailSurfaceInterests };
      if (next) interests[surfaceId] = next;
      else delete interests[surfaceId];
      return {
        taskDetailSurfaceInterests: interests,
      };
    });
  },

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
    }
    if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) return;
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
      if (!isTaskDetailTokenCurrent(result.token, scope)) {
        const current = get().taskDetailById[key];
        if (current?.refreshPending && hasTaskDetailReadInterest(get(), identity))
          return get().ensureTaskDetail(identity);
        return;
      }
      set((state) => {
        const current = state.taskDetailById[key];
        if (!current) return state;
        return {
          taskDetailById: {
            ...state.taskDetailById,
            [key]: commitTaskDetailFull(current, result.token, result.value ?? null, result.error),
          },
        };
      });
    } catch {
      if (!isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName)) return;
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

  setTaskDetailDeletionIntent: (rawIdentity, intent, requestScope) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return false;
    if (
      get().isContextSwitching ||
      identity.contextId !== requestScope.contextId ||
      !isTaskDetailReadScopeCurrent(
        { ...requestScope, teamName: identity.teamName },
        get().activeContextId,
        identity.teamName
      )
    )
      return false;
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailById[key] ?? createTaskDetailReadEntry(identity);
      return {
        taskDetailById: {
          ...state.taskDetailById,
          [key]: setTaskDetailDeletionIntent(current, intent),
        },
      };
    });
    return true;
  },

  invalidateTaskDetailSource: (rawIdentity) => {
    if (!rawIdentity) return;
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return;
    invalidateTeamSnapshotResource(identity.contextId, identity.teamName);
    invalidateTeamTaskFullResource(identity);
    get().invalidateTaskDetailResources(identity);
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
    for (const entry of affected) get().invalidateTaskDetailResources(entry.identity);
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
    get().clearTaskDetailResourceWork(contextId, teamName);
    invalidateTeamSnapshotResource(contextId, teamName);
    set((state) => {
      const nextDetails = { ...state.taskDetailById };
      const nextSessions = { ...state.taskDetailSessionById };
      for (const [key, entry] of Object.entries(nextDetails)) {
        if (entry.identity.contextId === contextId && entry.identity.teamName === teamName) {
          invalidateTeamTaskFullResource(entry.identity);
          nextDetails[key] = markTaskDetailTeamUnavailable(entry);
          nextSessions[key] = retireTaskDetailSessionWork(
            nextSessions[key] ?? EMPTY_TASK_DETAIL_SESSION,
            true
          );
        }
      }
      return { taskDetailById: nextDetails, taskDetailSessionById: nextSessions };
    });
  },

  retireTaskDetailSessionWork: (
    scope,
    preservePendingAttachmentPreparation = scope === undefined
  ) => {
    set((state) => ({
      taskDetailSessionById: Object.fromEntries(
        Object.entries(state.taskDetailSessionById).map(([key, session]) => {
          const identity = state.taskDetailById[key]?.identity;
          const inScope =
            !scope ||
            (identity?.contextId === scope.contextId && identity?.teamName === scope.teamName);
          return [
            key,
            inScope
              ? retireTaskDetailSessionWork(session, preservePendingAttachmentPreparation)
              : session,
          ];
        })
      ),
    }));
  },

  hydrateTaskDetailSessionDraft: (rawIdentity, draft) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity) || identity.contextId !== get().activeContextId)
      return;
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION;
      const next = hydrateTaskDetailDraft(current, draft);
      return next === current
        ? state
        : {
            taskDetailSessionById: { ...state.taskDetailSessionById, [key]: next },
          };
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
      if (part === 'commentChips')
        next.commentChips = [...(value as TaskDetailSession['commentChips'])];
      if (part === 'pendingAttachments')
        next.pendingAttachments = [...(value as TaskDetailSession['pendingAttachments'])];
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

  failTaskDetailSubmitSession: (rawIdentity, revision, error) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: failTaskDetailSubmit(current, revision, error),
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

  failTaskDetailSaveSession: (rawIdentity, revision, error) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: failTaskDetailSave(current, revision, error),
        },
      };
    });
  },

  beginTaskDetailPendingAttachmentSession: (rawIdentity, attachment) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => ({
      taskDetailSessionById: {
        ...state.taskDetailSessionById,
        [key]: beginTaskDetailPendingAttachment(
          state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION,
          attachment
        ),
      },
    }));
  },

  completeTaskDetailPendingAttachmentSession: (rawIdentity, id, attachment) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: completeTaskDetailPendingAttachment(current, id, attachment),
        },
      };
    });
  },

  ignoreTaskDetailPendingAttachmentSession: (rawIdentity, id) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    const key = taskDetailKey(identity);
    set((state) => {
      const current = state.taskDetailSessionById[key];
      if (!current) return state;
      return {
        taskDetailSessionById: {
          ...state.taskDetailSessionById,
          [key]: ignoreTaskDetailPendingAttachment(current, id),
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
    if (identity.contextId !== get().activeContextId) return null;
    const confirmActivation = (tabId: string, created: boolean): OpenTaskDetailTabResult | null => {
      const current = get();
      const pane = current.paneLayout.panes.find((candidate) =>
        candidate.tabs.some((tab) => tab.id === tabId)
      );
      if (
        !pane ||
        pane.activeTabId !== tabId ||
        current.paneLayout.focusedPaneId !== pane.id ||
        current.activeTabId !== tabId
      ) {
        return null;
      }
      return { tabId, paneId: pane.id, created };
    };
    const state = get();
    const allTabs = state.getAllPaneTabs();
    const existing = allTabs.find(
      (tab) =>
        isTaskDetailTab(tab) &&
        tab.teamName === identity.teamName &&
        tab.taskDetail?.contextId === identity.contextId &&
        tab.taskDetail.taskId === identity.taskId
    );
    if (existing) {
      state.setActiveTab(existing.id);
      return confirmActivation(existing.id, false);
    }

    state.openTab({
      type: 'team',
      teamName: identity.teamName,
      taskDetail: { contextId: identity.contextId, taskId: identity.taskId },
      label: `${identity.teamName} #${deriveTaskDisplayId(identity.taskId)}`,
    });

    const opened = get()
      .getAllPaneTabs()
      .find(
        (tab) =>
          isTaskDetailTab(tab) &&
          tab.teamName === identity.teamName &&
          tab.taskDetail?.contextId === identity.contextId &&
          tab.taskDetail.taskId === identity.taskId
      );
    if (!opened) return null;
    return confirmActivation(opened.id, true);
  },
});
