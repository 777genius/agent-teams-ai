import {
  createTaskDetailReadAuthority,
  type TaskDetailDeletionIntent,
  type TaskDetailReadHandle,
  type TaskDetailReadResult,
  type TaskDetailReadScope,
  type TaskDetailReadToken,
} from '@features/team-task-detail/core';

import { captureContextScopedRequestEpoch } from '../utils/contextScopedRequestEpoch';

import { captureTeamLocalStateEpoch } from './teamLocalStateEpoch';

import type { AppState } from '../types';
import type { TeamChangeEvent } from '@shared/types';

export type { TaskDetailReadHandle, TaskDetailReadToken } from '@features/team-task-detail/core';

export const teamTaskDetailReadAuthority = createTaskDetailReadAuthority();

export function resetTeamTaskDetailReadAuthorityForTests(): void {
  teamTaskDetailReadAuthority.resetForTests();
}

export function captureTaskDetailReadScope(
  teamName: string,
  contextId: string
): TaskDetailReadScope {
  return {
    contextId,
    teamName,
    contextEpoch: captureContextScopedRequestEpoch(),
    teamStateEpoch: captureTeamLocalStateEpoch(teamName),
  };
}

export function isTaskDetailReadScopeCurrent(
  scope: TaskDetailReadScope,
  contextId: string,
  teamName: string
): boolean {
  return (
    scope.contextId === contextId &&
    scope.teamName === teamName &&
    captureContextScopedRequestEpoch() === scope.contextEpoch &&
    captureTeamLocalStateEpoch(teamName) === scope.teamStateEpoch
  );
}

export function isTaskDetailTokenCurrent(
  token: TaskDetailReadToken,
  scope: TaskDetailReadScope
): boolean {
  return teamTaskDetailReadAuthority.isTokenCurrent(token, scope);
}

export function isTaskDetailTeamUnavailable(
  state: Pick<
    AppState,
    | 'selectedTeamData'
    | 'selectedTeamName'
    | 'teamByName'
    | 'teamDataCacheByName'
    | 'teamManagementNoticeByTeam'
  >,
  teamName: string
): boolean {
  const snapshot =
    state.teamDataCacheByName[teamName] ??
    (state.selectedTeamName === teamName ? state.selectedTeamData : null);
  if (snapshot) return Boolean(snapshot.config.deletedAt);
  if (state.teamManagementNoticeByTeam[teamName]?.kind === 'trashed') return true;
  return Boolean(state.teamByName[teamName]?.deletedAt);
}

export function readTeamSnapshotResource<T>(
  teamName: string,
  scope: TaskDetailReadScope,
  read: (token: TaskDetailReadToken, markPhysicalStart: () => void) => Promise<T>,
  options?: { forceNew?: boolean; mode?: 'full' | 'thin'; deferPhysicalStart?: boolean }
): TaskDetailReadHandle<T> {
  return teamTaskDetailReadAuthority.readSnapshot(teamName, scope, read, options);
}

export function readTeamTaskFullResource<T>(
  identity: { contextId: string; teamName: string; taskId: string },
  scope: TaskDetailReadScope,
  read: (token: TaskDetailReadToken) => Promise<T>
): TaskDetailReadHandle<T> {
  return teamTaskDetailReadAuthority.readFull(identity, scope, read);
}

export function invalidateTeamSnapshotResource(contextId: string, teamName: string): void {
  teamTaskDetailReadAuthority.invalidateSnapshot(teamName, contextId);
}

export function invalidateTeamTaskFullResource(identity: {
  contextId: string;
  teamName: string;
  taskId: string;
}): void {
  teamTaskDetailReadAuthority.invalidateFull(identity);
}

export function invalidateAcceptedTaskDetailMutation(
  get: () => Pick<
    AppState,
    | 'activeContextId'
    | 'isContextSwitching'
    | 'invalidateTaskDetailSource'
    | 'setTaskDetailDeletionIntent'
  >,
  teamName: string,
  taskId: string,
  scope: Omit<TaskDetailReadScope, 'teamName'>,
  intent?: Exclude<TaskDetailDeletionIntent, null>
): void {
  const state = get();
  if (
    state.isContextSwitching ||
    !isTaskDetailReadScopeCurrent({ ...scope, teamName }, state.activeContextId, teamName)
  )
    return;
  const identity = { contextId: scope.contextId, teamName, taskId };
  if (intent && !state.setTaskDetailDeletionIntent(identity, intent, scope)) return;
  state.invalidateTaskDetailSource(identity);
}

/** Source invalidation belongs to the same task read authority as physical reads. */
export function invalidateTaskDetailForTeamChange(
  state: Pick<
    AppState,
    | 'activeContextId'
    | 'isContextSwitching'
    | 'invalidateTaskDetailTeamSource'
    | 'invalidateTaskDetailResources'
    | 'taskDetailResourcesById'
  >,
  event: TeamChangeEvent,
  staleRuntimeEvent: boolean
): void {
  if (staleRuntimeEvent || state.isContextSwitching) return;
  if (
    event.type === 'log-source-change' ||
    (event.type === 'task-log-change' && event.taskSignalKind === 'log')
  ) {
    const identities = new Map<string, { contextId: string; teamName: string; taskId: string }>();
    for (const entry of Object.values(state.taskDetailResourcesById)) {
      const identity = entry.identity;
      if (
        identity.contextId !== state.activeContextId ||
        identity.teamName !== event.teamName ||
        (event.taskId && identity.taskId !== event.taskId)
      )
        continue;
      identities.set(identity.taskId, identity);
    }
    for (const identity of identities.values()) state.invalidateTaskDetailResources(identity);
    return;
  }
  if (
    event.type !== 'task' &&
    !(event.type === 'task-log-change' && event.taskSignalKind !== 'log')
  )
    return;
  state.invalidateTaskDetailTeamSource(state.activeContextId, event.teamName, event.taskId);
}

/** Normalize transport failures after the caller has checked its captured read scope. */
export function unwrapTaskDetailReadResult<T>(result: TaskDetailReadResult<T>): T {
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error(typeof result.error === 'string' ? result.error : 'Failed to load team data', {
          cause: result.error,
        });
  }
  if (result.value === undefined) throw new Error('Task data read returned no value');
  return result.value;
}
