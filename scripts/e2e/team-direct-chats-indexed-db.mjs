import assert from 'node:assert/strict';

const DATABASE_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

function browserCall(operation, input) {
  return `(async () => {
    const databaseName = ${JSON.stringify(DATABASE_NAME)};
    const storeName = ${JSON.stringify(STORE_NAME)};
    const input = ${JSON.stringify(input)};
    const openDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    const transactionDone = (transaction, allowAbort = false) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve('complete');
      transaction.onabort = () => allowAbort
        ? resolve('aborted')
        : reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => {
        if (!allowAbort) reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      };
    });
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const database = await openDatabase();
    try {
      ${operation}
    } finally {
      database.close();
    }
  })()`;
}

export async function readKeyval(client, key) {
  return client.evaluate(
    browserCall(
      `const transaction = database.transaction(storeName, 'readonly');
      const result = await requestValue(transaction.objectStore(storeName).get(input.key));
      await transactionDone(transaction);
      return result;`,
      { key }
    )
  );
}

export async function writeKeyval(client, key, value) {
  await client.evaluate(
    browserCall(
      `const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(input.value, input.key);
      await transactionDone(transaction);
      return true;`,
      { key, value }
    )
  );
}

export async function assertAbortedWritePreservesKey(client, key, expectedValue) {
  const result = await client.evaluate(
    browserCall(
      `const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      await requestValue(store.put(input.attemptedValue, input.key));
      transaction.abort();
      const outcome = await transactionDone(transaction, true);
      return outcome;`,
      { key, attemptedValue: { ...expectedValue, fixtureAbortedMutation: true } }
    )
  );
  assert.equal(result, 'aborted', 'fixture transaction must abort');
  assert.deepEqual(
    await readKeyval(client, key),
    expectedValue,
    'aborted IndexedDB transaction must preserve the committed value'
  );
}
