import { expect, it } from 'vitest';
import { ScopedReadRequests } from '@features/team-read-recovery/core/application/ScopedReadRequests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('settles a displaced fresh waiter in the release-to-continuation gap without retiring the replacement', async () => {
  const requests = new ScopedReadRequests(() => 'TEST-retired');
  const scopeA = { contextId: 'TEST-context', contextEpoch: 1, teamStateEpoch: 0 };
  const scopeB = { ...scopeA, contextEpoch: 2 };
  const old = deferred<string>(),
    current = deferred<string>(),
    successor = deferred<string>();
  requests.set('TEST-team', old.promise, scopeA);
  const oldFresh = requests.queueFresh(
    'TEST-team',
    scopeA,
    () => Promise.resolve('TEST-old-fresh'),
    () => false
  );
  let oldSettled = false;
  void oldFresh.then(() => {
    oldSettled = true;
  });
  // The production owner releases before its promise reactions may start the successor.
  requests.release('TEST-team', old.promise);
  requests.set('TEST-team', current.promise, scopeB);
  const currentFresh = requests.queueFresh(
    'TEST-team',
    scopeB,
    () => successor.promise,
    () => true
  );
  old.resolve('TEST-old');
  await Promise.resolve();
  await Promise.resolve();
  expect(oldSettled).toBe(true);
  expect(await oldFresh).toBe('TEST-retired');
  requests.release('TEST-team', old.promise);
  expect(requests.get('TEST-team', scopeB)).toBe(current.promise);
  requests.release('TEST-team', current.promise);
  current.resolve('TEST-current');
  await Promise.resolve();
  successor.resolve('TEST-successor');
  expect(await currentFresh).toBe('TEST-successor');
  requests.clear();
});

it.each(['success', 'failure'] as const)(
  'keeps a new same-scope fresh demand behind its own predecessor (%s)',
  async (outcome) => {
    const requests = new ScopedReadRequests(() => 'TEST-retired');
    const scope = { contextId: 'TEST-context', contextEpoch: 1, teamStateEpoch: 0 };
    const first = deferred<string>(),
      replacement = deferred<string>(),
      successor = deferred<string>();
    requests.set('TEST-team', first.promise, scope);
    const earlierFresh = requests.queueFresh(
      'TEST-team',
      scope,
      () => Promise.resolve('TEST-unexpected-earlier-read'),
      () => true
    );
    // A is settled/released, but its queued promise reaction has not run.
    first.resolve('TEST-first');
    requests.release('TEST-team', first.promise);
    requests.set('TEST-team', replacement.promise, scope);
    let successorReads = 0;
    const laterFresh = requests.queueFresh(
      'TEST-team',
      scope,
      () => {
        successorReads++;
        requests.set('TEST-team', successor.promise, scope);
        return successor.promise;
      },
      () => true
    );
    let laterSettled = false;
    void laterFresh.then(
      () => {
        laterSettled = true;
      },
      () => {
        laterSettled = true;
      }
    );
    // Keep B active while A's queued reaction adopts it.
    await Promise.resolve();
    await Promise.resolve();
    requests.release('TEST-team', replacement.promise);
    replacement.resolve('TEST-replacement');
    expect(await earlierFresh).toBe('TEST-replacement');
    await Promise.resolve();
    expect(successorReads).toBe(1);
    expect(laterSettled).toBe(false);
    expect(requests.get('TEST-team', scope)).toBe(successor.promise);
    if (outcome === 'success') {
      successor.resolve('TEST-successor');
      expect(await laterFresh).toBe('TEST-successor');
    } else {
      const error = new Error('TEST-original-successor-error');
      successor.reject(error);
      await expect(laterFresh).rejects.toBe(error);
    }
    requests.clear();
  }
);
