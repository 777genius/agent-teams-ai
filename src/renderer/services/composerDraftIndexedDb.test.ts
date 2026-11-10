import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexedDbHarness = vi.hoisted(() => {
  const transaction = { abort: vi.fn() };
  const store = { transaction } as unknown as IDBObjectStore;
  const promisifyRequest = vi.fn<() => Promise<void>>();
  return { store, transaction, promisifyRequest };
});

vi.mock('idb-keyval', () => ({
  createStore:
    () =>
    async <T,>(
      _mode: IDBTransactionMode,
      callback: (store: IDBObjectStore) => Promise<T>
    ): Promise<T> => callback(indexedDbHarness.store),
  promisifyRequest: indexedDbHarness.promisifyRequest,
}));

import { composerDraftReadwrite } from './composerDraftIndexedDb';

describe('composerDraftReadwrite', () => {
  beforeEach(() => {
    indexedDbHarness.transaction.abort.mockReset();
    indexedDbHarness.promisifyRequest.mockReset();
    indexedDbHarness.promisifyRequest.mockResolvedValue(undefined);
  });

  it('aborts the IndexedDB transaction when the operation callback fails', async () => {
    const callbackError = new Error('callback failed');

    await expect(
      composerDraftReadwrite(async () => {
        throw callbackError;
      })
    ).rejects.toBe(callbackError);

    expect(indexedDbHarness.transaction.abort).toHaveBeenCalledOnce();
  });

  it('reuses the original completion after abort emits its only terminal event', async () => {
    const callbackError = new Error('callback failed');
    let rejectCompletion!: (error: Error) => void;
    indexedDbHarness.promisifyRequest
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCompletion = reject;
          })
      )
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    indexedDbHarness.transaction.abort.mockImplementationOnce(() => {
      rejectCompletion(new Error('transaction aborted'));
    });

    const settled = await Promise.race([
      composerDraftReadwrite(async () => {
        throw callbackError;
      }).catch((error: unknown) => error),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(settled).toBe(callbackError);
    expect(indexedDbHarness.promisifyRequest).toHaveBeenCalledOnce();
    expect(indexedDbHarness.transaction.abort).toHaveBeenCalledOnce();
  });
});
