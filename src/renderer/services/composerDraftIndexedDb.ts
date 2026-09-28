import { createStore, promisifyRequest } from 'idb-keyval';

const storeFactory = createStore('keyval-store', 'keyval');

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return promisifyRequest(transaction).then(() => undefined);
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export function composerDraftEntriesByPrefix(
  store: IDBObjectStore,
  prefix: string
): Promise<Array<readonly [string, unknown]>> {
  return new Promise((resolve, reject) => {
    const entries: Array<readonly [string, unknown]> = [];
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        entries.push([cursor.key, cursor.value]);
      }
      cursor.continue();
    };
  });
}

export function composerDraftReadwrite<T>(
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  return storeFactory('readwrite', async (store) => {
    const completion = transactionDone(store.transaction);
    void completion.catch(() => undefined);
    try {
      const result = await operation(store);
      await completion;
      return result;
    } catch (error) {
      try {
        store.transaction.abort();
      } catch {
        // The transaction may already have aborted because an IDB request failed.
      }
      await completion.catch(() => undefined);
      throw error;
    }
  });
}
