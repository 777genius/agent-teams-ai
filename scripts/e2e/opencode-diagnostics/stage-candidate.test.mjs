import assert from 'node:assert/strict';
import test from 'node:test';
import { candidatePages } from './stage-candidate.mjs';

for (const key of ['jobs', 'artifacts']) {
  test(`${key}: collects candidates and ambiguity beyond the first 100 entries`, () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, name: 'other' }));
    entries[150].name = 'candidate';
    entries[200].name = 'candidate';
    const calls = [];
    const actual = candidatePages(endpoint => {
      calls.push(endpoint);
      const page = Number(new URL(`https://example.test/${endpoint}`).searchParams.get('page'));
      return { total_count: entries.length, [key]: entries.slice((page - 1) * 100, page * 100) };
    }, `runs/42/${key}`, key);
    assert.deepEqual(actual, entries);
    assert.equal(actual.filter(item => item.name === 'candidate').length, 2);
    assert.deepEqual(calls, [1, 2, 3].map(page => `runs/42/${key}?per_page=100&page=${page}`));
  });
}

test('empty and exact full-page listings finish without unnecessary requests', () => {
  for (const count of [0, 100]) {
    let calls = 0;
    const entries = Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
    assert.deepEqual(candidatePages(() => {
      calls++;
      return { total_count: count, jobs: entries };
    }, 'jobs', 'jobs'), entries);
    assert.equal(calls, 1);
  }
});

test('invalid totals, excessive listings and incomplete pages fail closed', () => {
  for (const result of [
    { jobs: [] }, { total_count: -1, jobs: [] }, { total_count: 0.5, jobs: [] },
    { total_count: 10001, jobs: [] }, { total_count: 1, jobs: [] },
    { total_count: 0, jobs: [{ id: 1 }] }, { total_count: 0 },
    { total_count: 1, jobs: [{ id: '1' }] },
  ]) assert.throws(() => candidatePages(() => result, 'jobs', 'jobs'));
});

test('changed totals and overlapping identities fail closed on subsequent pages', () => {
  for (const second of [
    { total_count: 102, jobs: [{ id: 101 }, { id: 102 }] },
    { total_count: 101, jobs: [{ id: 100 }] },
    { total_count: 101, jobs: [] },
  ]) {
    let calls = 0;
    assert.throws(() => candidatePages(() => ++calls === 1
      ? { total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }
      : second, 'jobs', 'jobs'));
    assert.equal(calls, 2);
  }
});

test('the maximum listing completes within the explicit request cap', () => {
  let calls = 0;
  const items = candidatePages(() => {
    const offset = calls++ * 100;
    return { total_count: 10000, jobs: Array.from({ length: 100 }, (_, i) => ({ id: offset + i + 1 })) };
  }, 'jobs', 'jobs');
  assert.equal(items.length, 10000);
  assert.equal(calls, 100);
});
