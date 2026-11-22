import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeCurrentnessTiming } from '../dist/adapters/providers/OpenCodeCurrentnessTiming.js';
import type { OpenCodeCurrentnessPhase, OpenCodeCurrentnessStats,
  OpenCodeCurrentnessWindow } from '../dist/adapters/providers/OpenCodeCurrentnessTiming.js';

type Record = { phase: OpenCodeCurrentnessPhase; stats: OpenCodeCurrentnessStats };
type Timing = ReturnType<typeof createOpenCodeCurrentnessTiming>;
function call<T>(timing: Timing, original: () => T): T {
  const finish = timing.enter();
  try { return original(); } finally { finish(); }
}

test('timing is lazy, bounded to four original windows and closes each once', () => {
  const records: Record[] = [];
  let at = 100, reads = 0, calls = 0;
  const timing = createOpenCodeCurrentnessTiming((phase, stats) => records.push({ phase, stats }),
    () => { reads++; return at; });
  call(timing, () => { calls++; });
  timing.begin('catalog-4' as OpenCodeCurrentnessWindow)();
  assert.equal(reads, 0);
  for (const window of ['identity', 'catalog-1', 'catalog-2', 'catalog-3'] as const) {
    const end = timing.begin(window);
    call(timing, () => { calls++; at += 7; });
    end(); end(); timing.begin(window)();
  }
  assert.equal(calls, 5); assert.equal(reads, 8); assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.stats), Array.from({ length: 4 }, () => ({
    currentCalls: 1, currentElapsedMs: 7,
  })));
  call(timing, () => { calls++; });
  assert.equal(reads, 8, 'closed windows perform no diagnostic clock reads');
});

test('nested calls count separately while their elapsed wall time is charged once', () => {
  const records: Record[] = [];
  let at = 0;
  const timing = createOpenCodeCurrentnessTiming((phase, stats) => records.push({ phase, stats }), () => at);
  const end = timing.begin('identity');
  const result = call(timing, () => {
    at = 10;
    assert.equal(call(timing, () => { at = 25; return false; }), false);
    at = 30; return 'TEST-original-result';
  });
  end();
  assert.equal(result, 'TEST-original-result');
  assert.deepEqual(records, [{ phase: 'identity-currentness-summary',
    stats: { currentCalls: 2, currentElapsedMs: 30 } }]);
});

test('overlapping windows observe the same call without moving earlier work into a new window', () => {
  const records: Record[] = [];
  let at = 10;
  const timing = createOpenCodeCurrentnessTiming((phase, stats) => records.push({ phase, stats }), () => at);
  const endIdentity = timing.begin('identity');
  call(timing, () => {
    at = 15;
    const endCatalog = timing.begin('catalog-1');
    call(timing, () => { at = 25; });
    endCatalog(); at = 30;
  });
  endIdentity();
  assert.deepEqual(records, [
    { phase: 'catalog-1-currentness-summary', stats: { currentCalls: 1, currentElapsedMs: 10 } },
    { phase: 'identity-currentness-summary', stats: { currentCalls: 2, currentElapsedMs: 20 } },
  ]);
});

test('in-place marks preserve callback receiver, arguments, return identity and original exception', () => {
  const values: OpenCodeCurrentnessStats[] = [];
  const timing = createOpenCodeCurrentnessTiming((_phase, stats) => values.push(stats), () => 10);
  const result = {}, argument = {}, failure = Error('TEST-original-error');
  let calls = 0;
  const owner = { original(value: object, throws = false) {
    assert.equal(this, owner); assert.equal(value, argument); calls++;
    if (throws) throw failure;
    return result;
  } };
  const end = timing.begin('identity');
  assert.equal(call(timing, () => owner.original(argument)), result);
  assert.throws(() => call(timing, () => owner.original(argument, true)), error => error === failure);
  end(); assert.equal(calls, 2);
  assert.deepEqual(values, [{ currentCalls: 2, currentElapsedMs: 0 }]);
});

for (const fault of ['throw', 'nan', 'infinity', 'negative', 'backward', 'oversized'] as const) {
  test('invalid diagnostic clock cannot replace original values or errors: ' + fault, () => {
    const records: Record[] = [];
    let reads = 0, calls = 0;
    const failure = Error('TEST-original-error');
    const timing = createOpenCodeCurrentnessTiming((phase, stats) => records.push({ phase, stats }), () => {
      if (++reads === 1) return 10;
      if (fault === 'throw') throw Error('TEST-clock-error');
      return fault === 'nan' ? NaN : fault === 'infinity' ? Infinity : fault === 'negative' ? -1
        : fault === 'backward' ? 9 : 3_600_011;
    });
    const end = timing.begin('identity');
    assert.throws(() => call(timing, () => { calls++; throw failure; }), error => error === failure);
    assert.doesNotThrow(end);
    assert.equal(calls, 1); assert.deepEqual(records, []);
  });
}

test('a throwing sink and a repeated finish cannot alter the original result or retry emission', () => {
  let writes = 0;
  const timing = createOpenCodeCurrentnessTiming(() => { writes++; throw Error('TEST-sink-error'); }, () => 10);
  const end = timing.begin('identity'), finish = timing.enter();
  assert.doesNotThrow(finish); assert.doesNotThrow(finish);
  assert.doesNotThrow(end); assert.doesNotThrow(end);
  timing.begin('identity')();
  assert.equal(writes, 1);
});

test('closing during an original call omits an incomplete observation and keeps that call intact', () => {
  const records: Record[] = [];
  const timing = createOpenCodeCurrentnessTiming((phase, stats) => records.push({ phase, stats }), () => 10);
  const end = timing.begin('identity');
  assert.equal(call(timing, () => { end(); return true; }), true);
  end(); assert.deepEqual(records, []);
});

test('a closed window is removed before a reentrant sink observes another original window', () => {
  const records: Record[] = [];
  let at = 0;
  const timing = createOpenCodeCurrentnessTiming((phase, stats) => {
    records.push({ phase, stats });
    if (phase === 'identity-currentness-summary') {
      const end = timing.begin('catalog-1');
      call(timing, () => { at += 3; }); end();
    }
  }, () => at);
  const end = timing.begin('identity');
  call(timing, () => { at += 5; }); end();
  assert.deepEqual(records, [
    { phase: 'identity-currentness-summary', stats: { currentCalls: 1, currentElapsedMs: 5 } },
    { phase: 'catalog-1-currentness-summary', stats: { currentCalls: 1, currentElapsedMs: 3 } },
  ]);
});

test('an absent observer does not read the diagnostic clock or alter callback results', () => {
  const timing = createOpenCodeCurrentnessTiming(undefined, () => { throw Error('TEST-unexpected-clock'); });
  const end = timing.begin('identity');
  assert.equal(call(timing, () => false), false); end();
});
