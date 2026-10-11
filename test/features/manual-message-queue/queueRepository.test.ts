import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queueScopeKey } from '../../../src/features/manual-message-queue/core/domain/queue';
import { IndexedDbQueueRepository } from '../../../src/features/manual-message-queue/renderer/adapters/queueRepository';
import {
  composerDraftReadwrite,
  requestValue,
} from '../../../src/renderer/services/composerDraftIndexedDb';
import { composerWorkingIndexKey } from '../../../src/renderer/utils/composerDraftIdentity';

import { clearStore, directRoute, readWorking, scope, seed, working } from './queueFixture';

describe('manual queue real IndexedDB transaction', () => {
  beforeEach(clearStore);
  it('atomically consumes the captured revision and summary, preserves order, and isolates root/context/chat', async () => {
    const repository = new IndexedDbQueueRepository();
    const first = working('First');
    await seed(first);
    const changed = vi.fn();
    repository.subscribe(changed);
    const cleared = await repository.enqueue(scope, directRoute, first, () => true);
    expect(await readWorking(first)).toEqual(cleared);
    expect(cleared.content).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    const summary = await composerDraftReadwrite((store) =>
      requestValue(store.get(composerWorkingIndexKey(scope.contextId, scope.teamName)))
    );
    expect(summary).toEqual({ version: 1, summaries: [] });
    const second = working('Second');
    await seed(second);
    await repository.enqueue(scope, directRoute, second, () => true);
    let rows = await repository.list(scope, () => false);
    const [a, b] = rows;
    await repository.edit(b, 'Edited second');
    rows = await repository.list(scope, () => false);
    expect(rows.map((row) => row.text)).toEqual(['First', 'Edited second']);
    expect(rows.map((row) => row.queueItemId)).toEqual([a.queueItemId, b.queueItemId]);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    await expect(repository.remove(b)).rejects.toThrow('queue-conflict');
    await repository.remove(rows[1]);
    expect((await repository.list(scope, () => false)).map((row) => row.text)).toEqual(['First']);
    for (const other of [
      { ...scope, root: '/other' },
      { ...scope, contextId: 'ssh-test', host: 'test' },
      { ...scope, chat: 'direct:alice' },
    ]) {
      expect(await repository.list(other, () => false)).toEqual([]);
    }
  });
  it('rolls back on concurrent text, epoch change, unsupported schema, and actual transaction abort', async () => {
    const repository = new IndexedDbQueueRepository();
    const old = working('Captured');
    const newer = {
      ...old,
      workingRevision: crypto.randomUUID(),
      content: { ...old.content!, text: 'New text' },
    };
    await seed(newer);
    await expect(repository.enqueue(scope, directRoute, old, () => true)).rejects.toThrow(
      'queue-conflict'
    );
    expect(await readWorking(old)).toEqual(newer);
    await expect(repository.enqueue(scope, directRoute, newer, () => false)).rejects.toThrow(
      'rootUnavailable'
    );
    expect(await readWorking(old)).toEqual(newer);
    await composerDraftReadwrite(async (store) => {
      store.put({ version: 7 }, queueScopeKey(scope));
    });
    await expect(repository.enqueue(scope, directRoute, newer, () => true)).rejects.toThrow(
      'queue-schema'
    );
    expect(await readWorking(old)).toEqual(newer);
    await composerDraftReadwrite(async (store) => {
      store.delete(queueScopeKey(scope));
    });
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore
    ) {
      this.transaction.abort();
      throw new DOMException('Test quota failure', 'QuotaExceededError');
    });
    const changed = vi.fn();
    repository.subscribe(changed);
    await expect(repository.enqueue(scope, directRoute, newer, () => true)).rejects.toThrow(
      'Test quota failure'
    );
    put.mockRestore();
    expect(changed).not.toHaveBeenCalled();
    expect(await readWorking(old)).toEqual(newer);
    expect(await repository.list(scope, () => false)).toEqual([]);
  });
  it('keeps a live remount sending, freezes only orphan attempts, and never permits unknown resend or edit', async () => {
    const repository = new IndexedDbQueueRepository();
    const draft = working('Frozen');
    await seed(draft);
    await repository.enqueue(scope, directRoute, draft, () => true);
    const [row] = await repository.list(scope, () => false);
    const messageId = crypto.randomUUID();
    const claimed = await repository.claim(row, { messageId, text: 'Frozen', actionMode: 'do' });
    expect(messageId).not.toBe(row.queueItemId);
    expect((await repository.list(scope, (id) => id === messageId))[0]).toEqual(claimed);
    const [recovered] = await new IndexedDbQueueRepository().list(scope, () => false);
    expect(recovered.state).toBe('unknown');
    expect(recovered.attempt).toEqual(claimed.attempt);
    await expect(repository.edit(recovered, 'Changed')).rejects.toThrow('queue-frozen');
    await expect(
      repository.claim(recovered, {
        messageId: crypto.randomUUID(),
        text: 'Changed',
        actionMode: 'do',
      })
    ).rejects.toThrow('queue-frozen');
    await repository.remove(recovered);
    expect(await repository.list(scope, () => false)).toEqual([]);
  });
});
