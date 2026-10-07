import { expect, it } from 'vitest';
import { ScopedReadRequests } from '@features/team-read-recovery/core/application/ScopedReadRequests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
