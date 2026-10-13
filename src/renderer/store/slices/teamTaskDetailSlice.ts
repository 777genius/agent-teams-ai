import {
  applyTaskDetailReadStart,
  beginTaskDetailFullRead,
  canCommitTaskDetailFullRead,
  commitTaskDetailFull,
  createTaskDetailReadEntry,
  EMPTY_TASK_DETAIL_SESSION,
  invalidateTaskDetailFull,
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
  type OpenTaskDetailTabResult,
  type TaskDetailIdentity,
  taskDetailKey,
  type TaskDetailReadEntry,
  type TaskDetailSession,
} from '@features/team-task-detail/renderer';
import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { AppState } from '../types';
import type { TeamTaskWithKanban } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface TeamTaskDetailSlice {
  taskDetailById: Record<string, TaskDetailReadEntry>;
  taskDetailSessionById: Record<string, TaskDetailSession>;
  ensureTaskDetail: (identity: TaskDetailIdentity) => Promise<void>;
  invalidateTaskDetailSource: (identity?: TaskDetailIdentity) => void;
  clearTaskDetailTeamWork: (contextId: string, teamName: string) => void;
  updateTaskDetailSession: (
    identity: TaskDetailIdentity,
    update: Partial<TaskDetailSession>
  ) => void;
  openTaskDetailTab: (identity: TaskDetailIdentity) => OpenTaskDetailTabResult | null;
}

const inFlightTaskDetailReads = new Map<string, Promise<void>>();

export const createTeamTaskDetailSlice: StateCreator<AppState, [], [], TeamTaskDetailSlice> = (
  set,
  get
) => ({
  taskDetailById: {},
  taskDetailSessionById: {},

  ensureTaskDetail: async (rawIdentity) => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!isValidTaskDetailIdentity(identity)) return;
    const key = taskDetailKey(identity);
    const existingInFlight = inFlightTaskDetailReads.get(key);
    if (existingInFlight) {
      await existingInFlight;
      return;
    }

    const run = (async () => {
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

      const beforeRead = get().taskDetailById[key];
      if (
        !beforeRead ||
        !canCommitTaskDetailFullRead(beforeRead, {
          identity,
          sourceEpoch: beforeRead.sourceEpoch,
          serial: beforeRead.latestStartedFullSerial,
        })
      )
        return;

      const token = beginTaskDetailFullRead(beforeRead);
      set((state) => ({
        taskDetailById: {
          ...state.taskDetailById,
          [key]: applyTaskDetailReadStart(beforeRead, token),
        },
      }));

      let result: TeamTaskWithKanban | null = null;
      let error: unknown;
      try {
        result = await unwrapIpc('team:getTask', () =>
          api.teams.getTask(identity.teamName, identity.taskId)
        );
      } catch (caught) {
        error = caught;
      }

      set((state) => {
        const current = state.taskDetailById[key];
        if (!current) return state;
        return {
          taskDetailById: {
            ...state.taskDetailById,
            [key]: commitTaskDetailFull(current, token, result, error),
          },
        };
      });
    })().finally(() => {
      inFlightTaskDetailReads.delete(key);
    });

    inFlightTaskDetailReads.set(key, run);
    await run;
  },

  invalidateTaskDetailSource: (rawIdentity) => {
    if (!rawIdentity) return;
    const identity = normalizeTaskDetailIdentity(rawIdentity);
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
    set((state) => ({
      taskDetailSessionById: {
        ...state.taskDetailSessionById,
        [key]: {
          ...(state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION),
          ...update,
          editRevision:
            (state.taskDetailSessionById[key] ?? EMPTY_TASK_DETAIL_SESSION).editRevision +
            ('commentText' in update || 'subjectDraft' in update || 'descriptionDraft' in update
              ? 1
              : 0),
        },
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
