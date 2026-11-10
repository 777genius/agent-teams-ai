import { taskDetailKey } from './taskDetailIdentity';

import type { TaskDetailIdentity } from '../../contracts';

export interface TaskDetailReadScope {
  contextId: string;
  teamName: string;
  contextEpoch: number;
  teamStateEpoch: number;
}

export interface TaskDetailReadToken {
  resource: 'snapshot' | 'full';
  key: string;
  sourceEpoch: number;
  /** Per-resource request order. It is independent across task identities. */
  serial: number;
  /** Global order assigned only when a callback represents a physical start. */
  physicalStartOrder: number;
  scope: TaskDetailReadScope;
}

export interface TaskDetailReadResult<T> {
  token: TaskDetailReadToken;
  value?: T;
  error?: unknown;
}

export interface TaskDetailReadHandle<T> {
  token: TaskDetailReadToken;
  result: Promise<TaskDetailReadResult<T>>;
}

export function taskDetailFullResourceKey(identity: TaskDetailIdentity): string {
  return `full:${taskDetailKey(identity)}`;
}

function taskDetailSnapshotResourcePrefix(
  scope: Pick<TaskDetailReadScope, 'contextId' | 'teamName'>
): string {
  return `snapshot:${JSON.stringify([scope.contextId, scope.teamName])}:`;
}

export function taskDetailSnapshotResourceKey(
  scope: Pick<TaskDetailReadScope, 'contextId' | 'teamName'>,
  mode: 'full' | 'thin' = 'full'
): string {
  return `${taskDetailSnapshotResourcePrefix(scope)}${mode}`;
}

export function isTaskDetailSnapshotResourceKey(
  key: string,
  scope: Pick<TaskDetailReadScope, 'contextId' | 'teamName'>
): boolean {
  return key.startsWith(taskDetailSnapshotResourcePrefix(scope));
}

export function isSameTaskDetailReadScope(
  left: TaskDetailReadScope,
  right: TaskDetailReadScope
): boolean {
  return (
    left.contextId === right.contextId &&
    left.teamName === right.teamName &&
    left.contextEpoch === right.contextEpoch &&
    left.teamStateEpoch === right.teamStateEpoch
  );
}

export function isTaskDetailReadTokenForResource(
  token: TaskDetailReadToken,
  entryIdentity: TaskDetailIdentity
): boolean {
  return token.resource === 'full' && token.key === taskDetailFullResourceKey(entryIdentity);
}
