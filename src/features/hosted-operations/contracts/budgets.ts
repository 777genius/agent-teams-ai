import { snapshotExactDataRecord } from './exactDataSnapshot';

export interface RetentionBudget {
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly maxTotalBytes: number;
}

export interface ReferenceLoadBudget {
  readonly maxReferences: number;
  readonly maxBytesPerReference: number;
  readonly maxTotalBytes: number;
  readonly maxConcurrentLoads: number;
}

function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('hosted-operations-budget-invalid');
  }
}

export function createRetentionBudget(value: RetentionBudget): RetentionBudget {
  const snapshot = snapshotExactDataRecord(
    value,
    ['maxEntries', 'maxAgeMs', 'maxTotalBytes'],
    'hosted-operations-budget-invalid',
    { rejectProxy: true }
  );
  const maxEntries = snapshot.maxEntries;
  const maxAgeMs = snapshot.maxAgeMs;
  const maxTotalBytes = snapshot.maxTotalBytes;
  assertNonNegativeSafeInteger(maxEntries);
  assertNonNegativeSafeInteger(maxAgeMs);
  assertNonNegativeSafeInteger(maxTotalBytes);
  return Object.freeze({ maxEntries, maxAgeMs, maxTotalBytes });
}

export function createReferenceLoadBudget(value: ReferenceLoadBudget): ReferenceLoadBudget {
  const snapshot = snapshotExactDataRecord(
    value,
    ['maxReferences', 'maxBytesPerReference', 'maxTotalBytes', 'maxConcurrentLoads'],
    'hosted-operations-budget-invalid',
    { rejectProxy: true }
  );
  const maxReferences = snapshot.maxReferences;
  const maxBytesPerReference = snapshot.maxBytesPerReference;
  const maxTotalBytes = snapshot.maxTotalBytes;
  const maxConcurrentLoads = snapshot.maxConcurrentLoads;
  assertNonNegativeSafeInteger(maxReferences);
  assertNonNegativeSafeInteger(maxBytesPerReference);
  assertNonNegativeSafeInteger(maxTotalBytes);
  if (
    typeof maxConcurrentLoads !== 'number' ||
    !Number.isSafeInteger(maxConcurrentLoads) ||
    maxConcurrentLoads < 1
  ) {
    throw new TypeError('hosted-operations-budget-invalid');
  }
  return Object.freeze({
    maxReferences,
    maxBytesPerReference,
    maxTotalBytes,
    maxConcurrentLoads,
  });
}
