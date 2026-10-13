import {
  createTaskDetailReadAuthority,
  type TaskDetailReadHandle,
  type TaskDetailReadScope,
  type TaskDetailReadToken,
} from '@features/team-task-detail/renderer';

import { captureContextScopedRequestEpoch } from '../utils/contextScopedRequestEpoch';

import { captureTeamLocalStateEpoch } from './teamLocalStateEpoch';

export type {
  TaskDetailReadHandle,
  TaskDetailReadToken,
} from '@features/team-task-detail/renderer';

export const teamTaskDetailReadAuthority = createTaskDetailReadAuthority();

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

export function readTeamSnapshotResource<T>(
  teamName: string,
  scope: TaskDetailReadScope,
  read: (token: TaskDetailReadToken) => Promise<T>,
  options?: { forceNew?: boolean }
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
