import { applyRetentionBudget, type RetentionCandidate } from '@features/hosted-operations';
import { describe, expect, it } from 'vitest';

const entry = (
  retentionKey: string,
  recordedAtMonotonicMs: number,
  byteLength: number
): RetentionCandidate<string> => ({
  retentionKey,
  recordedAtMonotonicMs,
  byteLength,
  value: retentionKey,
});

describe('applyRetentionBudget', () => {
  it('deterministically applies age, count, and byte limits oldest first', () => {
    const decision = applyRetentionBudget({
      entries: [
        entry('newest', 900, 4),
        entry('expired', 400, 4),
        entry('middle-b', 800, 4),
        entry('oldest-live', 500, 4),
        entry('middle-a', 700, 4),
      ],
      budget: {
        maxAgeMs: 500,
        maxEntries: 3,
        maxTotalBytes: 8,
      },
      nowMonotonicMs: 1_000,
    });

    expect(decision.retained.map(({ retentionKey }) => retentionKey)).toEqual([
      'middle-b',
      'newest',
    ]);
    expect(
      decision.evicted.map(({ entry: removed, reason }) => [removed.retentionKey, reason])
    ).toEqual([
      ['expired', 'age'],
      ['oldest-live', 'entry_count'],
      ['middle-a', 'total_bytes'],
    ]);
    expect(decision.retainedBytes).toBe(8);
    expect(Object.isFrozen(decision.retained)).toBe(true);
  });

  it('uses caller-supplied monotonic time and rejects future or duplicate records', () => {
    expect(() =>
      applyRetentionBudget({
        entries: [entry('future', 101, 1)],
        budget: { maxAgeMs: 10, maxEntries: 1, maxTotalBytes: 1 },
        nowMonotonicMs: 100,
      })
    ).toThrow('hosted-operations-retention-candidate-invalid');

    expect(() =>
      applyRetentionBudget({
        entries: [entry('same', 99, 1), entry('same', 100, 1)],
        budget: { maxAgeMs: 10, maxEntries: 2, maxTotalBytes: 2 },
        nowMonotonicMs: 100,
      })
    ).toThrow('hosted-operations-retention-key-duplicate');
  });

  it('rejects accessor-backed metadata without invoking the accessor', () => {
    let getterReads = 0;
    const candidate = Object.defineProperty(entry('accessor', 90, 1), 'byteLength', {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? 1 : Number.MAX_SAFE_INTEGER;
      },
    });

    expect(() =>
      applyRetentionBudget({
        entries: [candidate],
        budget: { maxAgeMs: 10, maxEntries: 1, maxTotalBytes: 1 },
        nowMonotonicMs: 100,
      })
    ).toThrow('hosted-operations-retention-candidate-invalid');
    expect(getterReads).toBe(0);
  });

  it('returns frozen metadata snapshots that cannot drift with proxy or caller mutation', () => {
    let directReads = 0;
    const retainedSource = { ...entry('retained', 95, 2) };
    const expiredSource = { ...entry('expired', 80, 3) };
    const retainedProxy = new Proxy(retainedSource, {
      get(target, key, receiver) {
        directReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const entries = [retainedProxy, expiredSource];
    const decision = applyRetentionBudget({
      entries,
      budget: { maxAgeMs: 10, maxEntries: 1, maxTotalBytes: 2 },
      nowMonotonicMs: 100,
    });

    retainedSource.retentionKey = 'mutated-retained';
    retainedSource.recordedAtMonotonicMs = 0;
    retainedSource.byteLength = Number.MAX_SAFE_INTEGER;
    expiredSource.retentionKey = 'mutated-expired';
    expiredSource.recordedAtMonotonicMs = 100;
    expiredSource.byteLength = 0;
    entries.length = 0;

    expect(directReads).toBe(0);
    expect(decision.retained).toHaveLength(1);
    expect(decision.retained[0]).toEqual(entry('retained', 95, 2));
    expect(decision.retained[0]).not.toBe(retainedProxy);
    expect(decision.evicted).toEqual([{ entry: entry('expired', 80, 3), reason: 'age' }]);
    expect(decision.retainedBytes).toBe(2);
    expect(Object.isFrozen(decision.retained[0])).toBe(true);
    expect(Object.isFrozen(decision.evicted[0].entry)).toBe(true);
  });
});
