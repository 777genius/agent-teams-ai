import { composerDraftReadwrite, requestValue } from '@renderer/services/composerDraftIndexedDb';
import { isComposerWorkingRecord } from '@renderer/services/composerDraftRecovery';
import {
  nextWorkingSummaries,
  workingIndexRecord,
} from '@renderer/services/composerDraftWorkingSummary';
import {
  composerDraftAddressKey,
  composerWorkingIndexKey,
} from '@renderer/utils/composerDraftIdentity';

import { decodeQueueIndex, queueScopeKey } from '../../core/domain/queue';

import type {
  QueueIndex,
  QueueItem,
  QueueRequest,
  QueueRoute,
  QueueScope,
} from '../../core/domain/queue';
import type { ComposerWorkingRecord } from '@renderer/types/composerDraft';

export interface QueuePersistence {
  list(
    scope: QueueScope,
    ownsAttempt: (attemptId: string) => boolean
  ): Promise<readonly QueueItem[]>;
  enqueue(
    scope: QueueScope,
    route: QueueRoute,
    captured: ComposerWorkingRecord,
    isCurrent: () => boolean
  ): Promise<ComposerWorkingRecord>;
  edit(item: QueueItem, text: string): Promise<void>;
  remove(item: QueueItem): Promise<void>;
  claim(item: QueueItem, request: QueueRequest): Promise<QueueItem>;
  settle(
    item: QueueItem,
    outcome: 'accepted' | 'unknown' | 'not-sent',
    detail?: string
  ): Promise<void>;
  subscribe(listener: () => void): () => void;
}
export class IndexedDbQueueRepository implements QueuePersistence {
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  async list(
    scope: QueueScope,
    ownsAttempt: (id: string) => boolean
  ): Promise<readonly QueueItem[]> {
    const items = await composerDraftReadwrite(async (store) => {
      const key = queueScopeKey(scope);
      const index = decodeQueueIndex(await requestValue<unknown>(store.get(key)), scope);
      const recovered = index.items.map((item) =>
        item.state === 'sending' && !ownsAttempt(item.attempt!.attemptId)
          ? {
              ...item,
              state: 'unknown' as const,
              revision: item.revision + 1,
              updatedAt: Date.now(),
            }
          : item
      );
      if (recovered.some((item, position) => item !== index.items[position])) {
        store.put({ ...index, items: recovered }, key);
      }
      return recovered;
    });
    return items;
  }
  async enqueue(
    scope: QueueScope,
    route: QueueRoute,
    captured: ComposerWorkingRecord,
    isCurrent: () => boolean
  ): Promise<ComposerWorkingRecord> {
    const cleared = await composerDraftReadwrite(async (store) => {
      const key = queueScopeKey(scope);
      const workingKey = composerDraftAddressKey(captured.address);
      const summaryKey = composerWorkingIndexKey(
        captured.address.contextId,
        captured.address.teamName
      );
      const [rawIndex, rawWorking, rawSummary] = await Promise.all([
        requestValue<unknown>(store.get(key)),
        requestValue<unknown>(store.get(workingKey)),
        requestValue<unknown>(store.get(summaryKey)),
      ]);
      if (!isCurrent()) throw new Error('rootUnavailable');
      const index = decodeQueueIndex(rawIndex, scope);
      if (
        !isComposerWorkingRecord(rawWorking) ||
        rawWorking.workingRevision !== captured.workingRevision ||
        JSON.stringify(rawWorking.content) !== JSON.stringify(captured.content) ||
        rawWorking.editorContext.kind !== 'plain' ||
        !captured.content ||
        captured.content.chips.length ||
        captured.content.attachments.length ||
        captured.content.restoredOrigin ||
        (captured.content.actionMode !== 'do' && captured.content.actionMode !== 'ask') ||
        (route.kind === 'group' && captured.content.actionMode !== 'do')
      )
        throw new Error('queue-conflict');
      const next: ComposerWorkingRecord = {
        ...rawWorking,
        content: null,
        workingRevision: crypto.randomUUID(),
        updatedAt: Date.now(),
      };
      const summaries = nextWorkingSummaries(rawSummary, captured.address, next);
      if (!summaries) throw new Error('queue-schema');
      const item: QueueItem = {
        queueItemId: crypto.randomUUID(),
        revision: 0,
        position: index.nextPosition,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scope,
        route,
        text: captured.content.text,
        actionMode: captured.content.actionMode,
        state: 'queued',
      };
      store.put(
        { version: 1, nextPosition: index.nextPosition + 1, items: [...index.items, item] },
        key
      );
      store.put(next, workingKey);
      store.put(workingIndexRecord(summaries), summaryKey);
      return next;
    });
    this.changed();
    return cleared;
  }
  private async mutate(
    item: QueueItem,
    transition: (current: QueueItem) => QueueItem | null
  ): Promise<QueueItem | null> {
    const next = await composerDraftReadwrite(async (store) => {
      const key = queueScopeKey(item.scope);
      const index = decodeQueueIndex(await requestValue<unknown>(store.get(key)), item.scope);
      const current = index.items.find((candidate) => candidate.queueItemId === item.queueItemId);
      if (current?.revision !== item.revision || current.state !== item.state)
        throw new Error('queue-conflict');
      const changed = transition(current);
      const updated = changed
        ? { ...changed, revision: current.revision + 1, updatedAt: Date.now() }
        : null;
      const items = index.items.flatMap((candidate) =>
        candidate.queueItemId === item.queueItemId ? (updated ? [updated] : []) : [candidate]
      );
      store.put({ ...index, items } satisfies QueueIndex, key);
      return updated;
    });
    this.changed();
    return next;
  }
  async edit(item: QueueItem, text: string): Promise<void> {
    if (item.state !== 'queued') throw new Error('queue-frozen');
    await this.mutate(item, (current) => ({ ...current, text, detail: undefined }));
  }
  async remove(item: QueueItem): Promise<void> {
    if (item.state === 'sending') throw new Error('queue-frozen');
    await this.mutate(item, () => null);
  }
  async claim(item: QueueItem, request: QueueRequest): Promise<QueueItem> {
    if (item.state !== 'queued' || request.messageId === item.queueItemId)
      throw new Error('queue-frozen');
    const claimed = await this.mutate(item, (current) => ({
      ...current,
      state: 'sending',
      detail: undefined,
      attempt: { attemptId: request.messageId, messageId: request.messageId, request },
    }));
    return claimed!;
  }
  async settle(
    item: QueueItem,
    outcome: 'accepted' | 'unknown' | 'not-sent',
    detail?: string
  ): Promise<void> {
    if (item.state !== 'sending') throw new Error('queue-frozen');
    await this.mutate(item, (current) =>
      outcome === 'accepted'
        ? null
        : {
            ...current,
            state: outcome === 'unknown' ? 'unknown' : 'queued',
            attempt: outcome === 'unknown' ? current.attempt : undefined,
            detail,
          }
    );
  }
}
export const queueRepository: QueuePersistence = new IndexedDbQueueRepository();
