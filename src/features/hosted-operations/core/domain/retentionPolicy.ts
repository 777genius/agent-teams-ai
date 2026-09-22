import { createRetentionBudget, type RetentionBudget } from '../../contracts';
import { snapshotDenseDataArray, snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';

export interface RetentionCandidate<T> {
  readonly retentionKey: string;
  readonly recordedAtMonotonicMs: number;
  readonly byteLength: number;
  readonly value: T;
}

export type RetentionEvictionReason = 'age' | 'entry_count' | 'total_bytes';

export interface RetentionEviction<T> {
  readonly entry: RetentionCandidate<T>;
  readonly reason: RetentionEvictionReason;
}

export interface RetentionDecision<T> {
  readonly retained: readonly RetentionCandidate<T>[];
  readonly evicted: readonly RetentionEviction<T>[];
  readonly retainedBytes: number;
}

function materializeCandidate<T>(value: unknown, nowMs: number): RetentionCandidate<T> {
  const candidate = snapshotExactDataRecord(
    value,
    ['retentionKey', 'recordedAtMonotonicMs', 'byteLength', 'value'],
    'hosted-operations-retention-candidate-invalid'
  );
  const retentionKey = candidate.retentionKey;
  const recordedAtMonotonicMs = candidate.recordedAtMonotonicMs;
  const byteLength = candidate.byteLength;
  if (
    typeof retentionKey !== 'string' ||
    retentionKey.length === 0 ||
    retentionKey.length > 256 ||
    typeof recordedAtMonotonicMs !== 'number' ||
    !Number.isSafeInteger(recordedAtMonotonicMs) ||
    recordedAtMonotonicMs < 0 ||
    recordedAtMonotonicMs > nowMs ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new TypeError('hosted-operations-retention-candidate-invalid');
  }

  return Object.freeze({
    retentionKey,
    recordedAtMonotonicMs,
    byteLength,
    value: candidate.value as T,
  });
}

function oldestFirst<T>(left: RetentionCandidate<T>, right: RetentionCandidate<T>): number {
  const timeOrder = left.recordedAtMonotonicMs - right.recordedAtMonotonicMs;
  if (timeOrder !== 0) return timeOrder;
  if (left.retentionKey === right.retentionKey) return 0;
  return left.retentionKey < right.retentionKey ? -1 : 1;
}

/** Applies age, count, then byte limits with a stable oldest-first eviction order. */
export function applyRetentionBudget<T>(input: {
  readonly entries: readonly RetentionCandidate<T>[];
  readonly budget: RetentionBudget;
  readonly nowMonotonicMs: number;
}): RetentionDecision<T> {
  const inputSnapshot = snapshotExactDataRecord(
    input,
    ['entries', 'budget', 'nowMonotonicMs'],
    'hosted-operations-retention-input-invalid'
  );
  const nowMs = inputSnapshot.nowMonotonicMs;
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('hosted-operations-retention-input-invalid');
  }
  const budget = createRetentionBudget(inputSnapshot.budget as RetentionBudget);
  const entries = snapshotDenseDataArray(
    inputSnapshot.entries,
    'hosted-operations-retention-input-invalid'
  ).map((candidate) => materializeCandidate<T>(candidate, nowMs));

  const keys = new Set<string>();
  for (const candidate of entries) {
    if (keys.has(candidate.retentionKey)) {
      throw new TypeError('hosted-operations-retention-key-duplicate');
    }
    keys.add(candidate.retentionKey);
  }

  const ordered = [...entries].sort(oldestFirst);
  const retained: RetentionCandidate<T>[] = [];
  const evicted: RetentionEviction<T>[] = [];
  let retainedBytes = 0;

  for (const entry of ordered) {
    if (nowMs - entry.recordedAtMonotonicMs > budget.maxAgeMs) {
      evicted.push(Object.freeze({ entry, reason: 'age' }));
      continue;
    }
    if (entry.byteLength > Number.MAX_SAFE_INTEGER - retainedBytes) {
      throw new TypeError('hosted-operations-retention-size-overflow');
    }
    retained.push(entry);
    retainedBytes += entry.byteLength;
  }

  while (retained.length > budget.maxEntries) {
    const entry = retained.shift();
    if (!entry) break;
    retainedBytes -= entry.byteLength;
    evicted.push(Object.freeze({ entry, reason: 'entry_count' }));
  }

  while (retainedBytes > budget.maxTotalBytes) {
    const entry = retained.shift();
    if (!entry) break;
    retainedBytes -= entry.byteLength;
    evicted.push(Object.freeze({ entry, reason: 'total_bytes' }));
  }

  return Object.freeze({
    retained: Object.freeze(retained),
    evicted: Object.freeze(evicted),
    retainedBytes,
  });
}
