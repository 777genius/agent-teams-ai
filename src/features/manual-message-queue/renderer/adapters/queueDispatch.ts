import {
  acquireComposerSubmission,
  classifyTransportResult,
  isComposerSubmissionActive,
  releaseComposerSubmission,
} from '@renderer/components/team/messages/composerSubmission';

import { queueScopeKey } from '../../core/domain/queue';

import type { QueueItem, QueueRequest, QueueScope } from '../../core/domain/queue';
import type { QueuePersistence } from './queueRepository';
import type { SendMessageResult } from '@shared/types';

export { isComposerSubmissionActive as ownsQueueAttempt };
export async function dispatchQueueItem(options: {
  item: QueueItem;
  repository: QueuePersistence;
  binding: () => Promise<QueueScope>;
  isCurrent: () => boolean;
  blockedReason: (item: QueueItem) => string | null;
  prepare: (item: QueueItem, messageId: string) => QueueRequest;
  transport: (
    item: QueueItem,
    request: QueueRequest
  ) => Promise<SendMessageResult | { saved: true }>;
}): Promise<void> {
  const { item, repository } = options;
  if (item.state !== 'queued') throw new Error('queue-frozen');
  const attemptId = crypto.randomUUID();
  if (!acquireComposerSubmission(item.scope.contextId, attemptId)) throw new Error('queue-busy');
  let claimed: QueueItem | null = null;
  try {
    if (
      options.blockedReason(item) ||
      !options.isCurrent() ||
      queueScopeKey(await options.binding()) !== queueScopeKey(item.scope)
    )
      throw new Error('rootUnavailable');
    const request = options.prepare(item, attemptId);
    claimed = await repository.claim(item, request);
    try {
      if (
        !options.isCurrent() ||
        options.blockedReason(item) ||
        queueScopeKey(await options.binding()) !== queueScopeKey(item.scope)
      )
        throw new Error('rootUnavailable');
    } catch {
      await repository.settle(claimed, 'not-sent', 'rootUnavailable');
      return;
    }
    let outcome: 'accepted' | 'unknown' | 'not-sent';
    let detail: string | undefined;
    try {
      const result = await options.transport(claimed, request);
      const classified =
        'saved' in result && result.saved
          ? { kind: 'accepted' as const }
          : classifyTransportResult(result as SendMessageResult);
      outcome = classified.kind === 'accepted' ? 'accepted' : 'unknown';
      detail = 'detail' in classified ? classified.detail : undefined;
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? cause.code : null;
      outcome =
        item.route.kind === 'group' &&
        typeof code === 'string' &&
        [
          'invalid-input',
          'invalid-members',
          'invalid-recipient',
          'reserved-group',
          'archived',
          'minimum-members',
          'not-member',
          'recipient-unavailable',
          'invalid-relay',
          'not-found',
        ].includes(code)
          ? 'not-sent'
          : 'unknown';
      detail = cause instanceof Error ? cause.message : String(cause);
    }
    await repository.settle(claimed, outcome, detail);
  } finally {
    releaseComposerSubmission(item.scope.contextId, attemptId);
  }
}
