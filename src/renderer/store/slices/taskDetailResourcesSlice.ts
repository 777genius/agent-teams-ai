import {
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
  taskDetailKey,
} from '@features/team-task-detail/core';
import { api } from '@renderer/api';
import {
  buildTaskChangeRequestOptions,
  buildTaskChangeSignature,
  deriveTaskSince,
} from '@renderer/utils/taskChangeRequest';

import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
} from '../team/taskDetailReadAuthority';
import {
  taskDetailResourceKey,
  type TaskDetailResourceKind,
  type TaskDetailVisibleResourceKind,
} from '../team/taskDetailResourceIdentity';

import type { AppState } from '../types';
import type { TaskDetailIdentity, TaskDetailReadScope } from '@features/team-task-detail/core';
import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
} from '@shared/types';
import type { StateCreator } from 'zustand';

type TaskDetailResourceValue =
  | TaskChangeSetV2
  | BoardTaskLogStreamSummary
  | BoardTaskLogStreamResponse
  | BoardTaskActivityEntry[]
  | BoardTaskActivityDetailResult
  | BoardTaskExactLogSummariesResponse
  | BoardTaskExactLogDetailResult;

export interface TaskDetailResourceEntry {
  identity: TaskDetailIdentity;
  kind: TaskDetailResourceKind;
  signature: string;
  data: TaskDetailResourceValue | null;
  error: string | null;
  loading: boolean;
  loaded: boolean;
  refreshPending: boolean;
  sourceRevision: number;
  scope: TaskDetailReadScope;
}

export interface TaskDetailVisibleDemand {
  identity: TaskDetailIdentity;
  resources: Partial<Record<TaskDetailVisibleResourceKind, string>>;
}

export interface TaskDetailResourcesSlice {
  taskDetailResourcesById: Record<string, TaskDetailResourceEntry>;
  taskDetailVisibleDemandById: Record<string, TaskDetailVisibleDemand>;
  taskDetailResourcesRevision: number;
  setTaskDetailVisibleResourceDemand: (
    surfaceId: string,
    identity: TaskDetailIdentity,
    kind: TaskDetailVisibleResourceKind,
    enabled: boolean,
    signature?: string
  ) => void;
  ensureTaskDetailChanges: (
    identity: TaskDetailIdentity,
    options: TaskChangeRequestOptions,
    signature: string,
    forceFresh?: boolean
  ) => Promise<void>;
  ensureTaskDetailLogSummary: (identity: TaskDetailIdentity) => Promise<void>;
  ensureTaskDetailLogStream: (identity: TaskDetailIdentity) => Promise<void>;
  ensureTaskDetailActivity: (identity: TaskDetailIdentity) => Promise<void>;
  ensureTaskDetailActivityDetail: (
    identity: TaskDetailIdentity,
    activityId: string
  ) => Promise<void>;
  ensureTaskDetailExactSummaries: (
    identity: TaskDetailIdentity,
    forceFresh?: boolean
  ) => Promise<void>;
  ensureTaskDetailExactDetail: (
    identity: TaskDetailIdentity,
    exactLogId: string,
    sourceGeneration: string,
    forceFresh?: boolean
  ) => Promise<void>;
  refreshTaskDetailVisibleResources: (
    kind?: TaskDetailVisibleResourceKind,
    forceFresh?: boolean
  ) => Promise<void>;
  invalidateTaskDetailResources: (identity: TaskDetailIdentity) => void;
  clearTaskDetailResourceWork: (contextId: string, teamName: string) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const createTaskDetailResourcesSlice: StateCreator<
  AppState,
  [],
  [],
  TaskDetailResourcesSlice
> = (set, get) => {
  const inFlight = new Map<string, { scope: TaskDetailReadScope; promise: Promise<void> }>();
  const visible = (
    identity: TaskDetailIdentity,
    kind: TaskDetailResourceKind,
    signature: string
  ): boolean => {
    const state = get();
    if (
      !isValidTaskDetailIdentity(identity) ||
      state.isContextSwitching ||
      state.activeContextId !== identity.contextId ||
      (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    )
      return false;
    const parentKind =
      kind === 'activity-detail' ? 'activity' : kind === 'exact-detail' ? 'exact-summaries' : kind;
    const parentSignature = parentKind === kind ? signature : 'default';
    return Object.values(state.taskDetailVisibleDemandById).some(
      (demand) =>
        taskDetailKey(demand.identity) === taskDetailKey(identity) &&
        demand.resources[parentKind as TaskDetailVisibleResourceKind] === parentSignature
    );
  };
  const ensureResource = (
    rawIdentity: TaskDetailIdentity,
    kind: TaskDetailResourceKind,
    signature: string,
    load: () => Promise<TaskDetailResourceValue>,
    forceFresh = false
  ): Promise<void> => {
    const identity = normalizeTaskDetailIdentity(rawIdentity);
    if (!visible(identity, kind, signature)) return Promise.resolve();
    const key = taskDetailResourceKey(identity, kind, signature);
    const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
    const current = get().taskDetailResourcesById[key];
    const sameScope =
      current &&
      isTaskDetailReadScopeCurrent(current.scope, get().activeContextId, identity.teamName);
    const pending = inFlight.get(key);
    if (
      pending &&
      isTaskDetailReadScopeCurrent(pending.scope, get().activeContextId, identity.teamName)
    )
      return pending.promise;
    if (
      sameScope &&
      !current.refreshPending &&
      !forceFresh &&
      (current.loaded || current.error !== null)
    )
      return Promise.resolve();
    const sourceRevision = current?.sourceRevision ?? 0;
    set((state) => ({
      taskDetailResourcesById: {
        ...state.taskDetailResourcesById,
        [key]: {
          identity,
          kind,
          signature,
          scope,
          sourceRevision,
          data: sameScope ? current.data : null,
          error: null,
          loading: true,
          loaded: Boolean(sameScope && current.loaded),
          refreshPending: false,
        },
      },
    }));
    const request = { scope, promise: Promise.resolve() };
    inFlight.set(key, request);
    const originCurrent = () =>
      !get().isContextSwitching &&
      isTaskDetailReadScopeCurrent(scope, get().activeContextId, identity.teamName);
    const canCommit = () =>
      inFlight.get(key) === request &&
      originCurrent() &&
      visible(identity, kind, signature) &&
      get().taskDetailResourcesById[key]?.sourceRevision === sourceRevision;
    let committed = false;
    request.promise = Promise.resolve()
      .then(async () => {
        if (!canCommit()) return;
        try {
          const data = await load();
          if (!canCommit()) return;
          committed = true;
          set((state) => ({
            taskDetailResourcesById: {
              ...state.taskDetailResourcesById,
              [key]: { ...state.taskDetailResourcesById[key], data, error: null, loaded: true },
            },
          }));
        } catch (cause) {
          if (!canCommit()) return;
          committed = true;
          set((state) => ({
            taskDetailResourcesById: {
              ...state.taskDetailResourcesById,
              [key]: { ...state.taskDetailResourcesById[key], error: errorMessage(cause) },
            },
          }));
        }
      })
      .finally(() => {
        if (inFlight.get(key) !== request) return;
        inFlight.delete(key);
        if (!originCurrent()) return;
        set((state) => {
          const entry = state.taskDetailResourcesById[key];
          if (entry?.scope !== scope) return state;
          return {
            taskDetailResourcesById: {
              ...state.taskDetailResourcesById,
              [key]: {
                ...entry,
                loading: false,
                refreshPending: entry.refreshPending || !committed,
              },
            },
            taskDetailResourcesRevision: state.taskDetailResourcesRevision + 1,
          };
        });
      });
    return request.promise;
  };

  const ensureVisibleKind = async (
    identity: TaskDetailIdentity,
    kind: TaskDetailVisibleResourceKind,
    signature: string,
    forceFresh: boolean
  ): Promise<void> => {
    if (kind === 'detail') return;
    if (kind === 'changes') {
      const task = get().taskDetailById[taskDetailKey(identity)]?.full ?? null;
      if (!task) return;
      if (signature !== buildTaskChangeSignature(buildTaskChangeRequestOptions(task))) return;
      const since = deriveTaskSince(task);
      await ensureResource(
        identity,
        'changes',
        signature,
        () =>
          api.review.getTaskChanges(
            identity.teamName,
            identity.taskId,
            buildTaskChangeRequestOptions(task, { since, summaryOnly: true, forceFresh })
          ),
        forceFresh
      );
      return;
    }
    if (kind === 'log-summary') {
      await ensureResource(
        identity,
        kind,
        signature,
        async () =>
          (await api.teams.getTaskLogStreamSummary?.(identity.teamName, identity.taskId)) ?? {
            segmentCount: 0,
          },
        forceFresh
      );
      return;
    }
    if (kind === 'log-stream') {
      await ensureResource(
        identity,
        kind,
        signature,
        () => api.teams.getTaskLogStream(identity.teamName, identity.taskId),
        forceFresh
      );
      return;
    }
    if (kind === 'activity') {
      await ensureResource(
        identity,
        kind,
        signature,
        () => api.teams.getTaskActivity(identity.teamName, identity.taskId),
        forceFresh
      );
      return;
    }
    await ensureResource(
      identity,
      'exact-summaries',
      signature,
      () => api.teams.getTaskExactLogSummaries(identity.teamName, identity.taskId),
      forceFresh
    );
  };

  return {
    taskDetailResourcesById: {},
    taskDetailVisibleDemandById: {},
    taskDetailResourcesRevision: 0,

    setTaskDetailVisibleResourceDemand: (surfaceId, rawIdentity, kind, enabled, signature) => {
      const identity = normalizeTaskDetailIdentity(rawIdentity);
      set((state) => {
        const current = state.taskDetailVisibleDemandById[surfaceId];
        const sameIdentity = current && taskDetailKey(current.identity) === taskDetailKey(identity);
        const nextSignature = signature ?? 'default';
        if (!enabled && (!sameIdentity || current.resources[kind] !== nextSignature)) return state;
        if (enabled && sameIdentity && current.resources[kind] === nextSignature) return state;
        const resources = { ...(sameIdentity ? current.resources : {}) };
        const wasEnabled = resources[kind] !== undefined;
        if (enabled) resources[kind] = nextSignature;
        else delete resources[kind];
        const next = { ...state.taskDetailVisibleDemandById };
        if (Object.keys(resources).length > 0) next[surfaceId] = { identity, resources };
        else delete next[surfaceId];
        const resourceEntries = { ...state.taskDetailResourcesById };
        let resourcesChanged = false;
        if (enabled && !wasEnabled && kind !== 'detail') {
          const resourceKey = taskDetailResourceKey(identity, kind, signature ?? 'default');
          const entry = resourceEntries[resourceKey];
          if (entry?.loaded) {
            resourceEntries[resourceKey] = { ...entry, refreshPending: true };
            resourcesChanged = true;
          }
        }
        return {
          taskDetailVisibleDemandById: next,
          ...(resourcesChanged ? { taskDetailResourcesById: resourceEntries } : {}),
          taskDetailResourcesRevision: state.taskDetailResourcesRevision + 1,
        };
      });
    },

    ensureTaskDetailChanges: (identity, options, signature, forceFresh = false) =>
      ensureResource(
        identity,
        'changes',
        signature,
        () =>
          api.review.getTaskChanges(identity.teamName, identity.taskId, { ...options, forceFresh }),
        forceFresh
      ),

    ensureTaskDetailLogSummary: (identity) =>
      ensureResource(identity, 'log-summary', 'default', async () => {
        return (
          (await api.teams.getTaskLogStreamSummary?.(identity.teamName, identity.taskId)) ?? {
            segmentCount: 0,
          }
        );
      }),

    ensureTaskDetailLogStream: (identity) =>
      ensureResource(identity, 'log-stream', 'default', () =>
        api.teams.getTaskLogStream(identity.teamName, identity.taskId)
      ),

    ensureTaskDetailActivity: (identity) =>
      ensureResource(identity, 'activity', 'default', () =>
        api.teams.getTaskActivity(identity.teamName, identity.taskId)
      ),

    ensureTaskDetailActivityDetail: (identity, activityId) =>
      ensureResource(
        identity,
        'activity-detail',
        activityId,
        () => api.teams.getTaskActivityDetail(identity.teamName, identity.taskId, activityId),
        true
      ),

    ensureTaskDetailExactSummaries: (identity, forceFresh = false) =>
      ensureResource(
        identity,
        'exact-summaries',
        'default',
        () => api.teams.getTaskExactLogSummaries(identity.teamName, identity.taskId),
        forceFresh
      ),

    ensureTaskDetailExactDetail: (identity, exactLogId, sourceGeneration, forceFresh = false) =>
      ensureResource(
        identity,
        'exact-detail',
        JSON.stringify([exactLogId, sourceGeneration]),
        () =>
          api.teams.getTaskExactLogDetail(
            identity.teamName,
            identity.taskId,
            exactLogId,
            sourceGeneration
          ),
        forceFresh
      ),

    refreshTaskDetailVisibleResources: async (kind, forceFresh = false) => {
      const work = new Map<string, [TaskDetailIdentity, TaskDetailVisibleResourceKind, string]>();
      for (const demand of Object.values(get().taskDetailVisibleDemandById)) {
        for (const [resourceKind, signature] of Object.entries(demand.resources)) {
          const visibleKind = resourceKind as TaskDetailVisibleResourceKind;
          if (kind && visibleKind !== kind) continue;
          work.set(taskDetailResourceKey(demand.identity, visibleKind, signature), [
            demand.identity,
            visibleKind,
            signature,
          ]);
        }
      }
      await Promise.all(
        [...work.values()].map(([identity, resourceKind, signature]) =>
          ensureVisibleKind(identity, resourceKind, signature, forceFresh)
        )
      );
    },

    invalidateTaskDetailResources: (rawIdentity) => {
      const identity = normalizeTaskDetailIdentity(rawIdentity);
      const identityKey = taskDetailKey(identity);
      set((state) => {
        const next = { ...state.taskDetailResourcesById };
        let changed = false;
        for (const [key, entry] of Object.entries(next)) {
          if (taskDetailKey(entry.identity) !== identityKey) continue;
          next[key] = { ...entry, sourceRevision: entry.sourceRevision + 1, refreshPending: true };
          changed = true;
        }
        return changed
          ? {
              taskDetailResourcesById: next,
              taskDetailResourcesRevision: state.taskDetailResourcesRevision + 1,
            }
          : { taskDetailResourcesRevision: state.taskDetailResourcesRevision + 1 };
      });
    },

    clearTaskDetailResourceWork: (contextId, teamName) => {
      set((state) => {
        const resources = { ...state.taskDetailResourcesById };
        const demands = { ...state.taskDetailVisibleDemandById };
        for (const [key, entry] of Object.entries(resources)) {
          if (entry.identity.contextId === contextId && entry.identity.teamName === teamName) {
            inFlight.delete(key);
            delete resources[key];
          }
        }
        for (const [surfaceId, demand] of Object.entries(demands)) {
          if (demand.identity.contextId === contextId && demand.identity.teamName === teamName) {
            delete demands[surfaceId];
          }
        }
        return {
          taskDetailResourcesById: resources,
          taskDetailVisibleDemandById: demands,
          taskDetailResourcesRevision: state.taskDetailResourcesRevision + 1,
        };
      });
    },
  };
};

export function selectTaskDetailResourceEntry(
  state: Pick<AppState, 'taskDetailResourcesById' | 'activeContextId' | 'isContextSwitching'>,
  identity: TaskDetailIdentity,
  kind: TaskDetailResourceKind,
  signature = 'default'
): TaskDetailResourceEntry | undefined {
  if (state.isContextSwitching || state.activeContextId !== identity.contextId) return undefined;
  const entry = state.taskDetailResourcesById[taskDetailResourceKey(identity, kind, signature)];
  return entry &&
    isTaskDetailReadScopeCurrent(entry.scope, state.activeContextId, identity.teamName)
    ? entry
    : undefined;
}
