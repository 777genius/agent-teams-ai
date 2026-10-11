import type { TaskRef } from '@shared/types/teamBoardTask';

export interface QueueScope {
  readonly transport: 'desktop-local-teams-v1';
  readonly root: string;
  readonly contextId: string;
  readonly host: string | null;
  readonly teamName: string;
  readonly chat: string;
}
export type QueueRoute =
  | {
      readonly kind: 'direct';
      readonly participant: string;
      readonly agentId?: string;
      readonly joinedAt?: number;
    }
  | { readonly kind: 'group'; readonly groupChatId: string; readonly recipientName: string | null };
export interface QueueRequest {
  readonly messageId: string;
  readonly text: string;
  readonly summary?: string;
  readonly actionMode: 'do' | 'ask';
  readonly taskRefs?: TaskRef[];
}
export interface QueueItem {
  readonly queueItemId: string;
  readonly revision: number;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly scope: QueueScope;
  readonly route: QueueRoute;
  readonly text: string;
  readonly actionMode: 'do' | 'ask';
  readonly state: 'queued' | 'sending' | 'unknown';
  readonly attempt?: {
    readonly attemptId: string;
    readonly messageId: string;
    readonly request: QueueRequest;
  };
  readonly detail?: string;
}
export interface QueueIndex {
  readonly version: 1;
  readonly nextPosition: number;
  readonly items: readonly QueueItem[];
}
export const QUEUE_STORAGE_PREFIX = 'manual-message-queue:v1:';

export function queueScopeKey(scope: QueueScope): string {
  return (
    QUEUE_STORAGE_PREFIX +
    encodeURIComponent(
      JSON.stringify([
        scope.transport,
        scope.root,
        scope.contextId,
        scope.host,
        scope.teamName,
        scope.chat,
      ])
    )
  );
}
export function queueTextValid(text: string, maximum: number): boolean {
  return text.trim().length > 0 && text.trim().length <= maximum;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export function decodeQueueIndex(raw: unknown, scope: QueueScope): QueueIndex {
  if (raw == null) return { version: 1, nextPosition: 0, items: [] };
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.nextPosition) ||
    (raw.nextPosition as number) < 0 ||
    !Array.isArray(raw.items)
  )
    throw new Error('queue-schema');
  const ids = new Set<string>();
  let previous = -1;
  for (const item of raw.items as unknown[]) {
    if (
      !object(item) ||
      typeof item.queueItemId !== 'string' ||
      ids.has(item.queueItemId) ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 0 ||
      !Number.isSafeInteger(item.position) ||
      (item.position as number) <= previous ||
      (item.position as number) >= (raw.nextPosition as number) ||
      !finite(item.createdAt) ||
      !finite(item.updatedAt) ||
      typeof item.text !== 'string' ||
      (item.actionMode !== 'do' && item.actionMode !== 'ask') ||
      !object(item.scope) ||
      queueScopeKey(item.scope as unknown as QueueScope) !== queueScopeKey(scope) ||
      !object(item.route) ||
      (item.state !== 'queued' && item.state !== 'sending' && item.state !== 'unknown') ||
      (item.detail !== undefined && typeof item.detail !== 'string')
    )
      throw new Error('queue-schema');
    const route = item.route;
    if (route.kind === 'direct') {
      if (
        typeof route.participant !== 'string' ||
        !route.participant ||
        (route.agentId !== undefined && typeof route.agentId !== 'string') ||
        (route.joinedAt !== undefined && !finite(route.joinedAt))
      )
        throw new Error('queue-schema');
    } else if (
      route.kind !== 'group' ||
      typeof route.groupChatId !== 'string' ||
      !route.groupChatId ||
      (route.recipientName !== null && typeof route.recipientName !== 'string') ||
      item.actionMode !== 'do'
    )
      throw new Error('queue-schema');
    if (
      scope.chat !==
      (route.kind === 'direct'
        ? 'direct:' + String(route.participant)
        : 'group:' + String(route.groupChatId))
    )
      throw new Error('queue-schema');
    if (item.state === 'queued') {
      if (item.attempt !== undefined) throw new Error('queue-schema');
    } else {
      const attempt = item.attempt;
      if (
        !object(attempt) ||
        typeof attempt.attemptId !== 'string' ||
        typeof attempt.messageId !== 'string' ||
        attempt.attemptId === item.queueItemId ||
        attempt.messageId !== attempt.attemptId ||
        !object(attempt.request) ||
        attempt.request.messageId !== attempt.messageId ||
        typeof attempt.request.text !== 'string' ||
        attempt.request.actionMode !== item.actionMode
      )
        throw new Error('queue-schema');
    }
    previous = item.position as number;
    ids.add(item.queueItemId);
  }
  return raw as unknown as QueueIndex;
}
