import { ReviewDraftHistoryWriteBuffer } from '@features/change-review-history/renderer';
import { describe, expect, it } from 'vitest';

describe('ReviewDraftHistoryWriteBuffer', () => {
  it('retries an unacknowledged predecessor before the coalesced latest draft', () => {
    const buffer = new ReviewDraftHistoryWriteBuffer<{ revision: number }>();
    const key = 'scope\0/repo/a.ts';
    buffer.enqueue(key, { revision: 2 });
    const inFlight = buffer.takeNext(key);
    expect(inFlight).toEqual({ revision: 2 });
    if (!inFlight) throw new Error('Expected an in-flight draft');

    buffer.enqueue(key, { revision: 3 });
    buffer.enqueue(key, { revision: 4 });
    buffer.markFailed(key, inFlight);

    expect(buffer.takeNext(key)).toEqual({ revision: 2 });
    expect(buffer.takeNext(key)).toEqual({ revision: 4 });
    expect(buffer.takeNext(key)).toBeUndefined();
  });

  it('keeps scopes isolated when flushing and reporting failures', () => {
    const buffer = new ReviewDraftHistoryWriteBuffer<number>();
    buffer.enqueue('scope-a\0a.ts', 1);
    buffer.enqueue('scope-b\0b.ts', 2);
    const failed = buffer.takeNext('scope-a\0a.ts');
    if (failed === undefined) throw new Error('Expected a failed draft');
    buffer.markFailed('scope-a\0a.ts', failed);

    expect(buffer.keys('scope-a\0')).toEqual(['scope-a\0a.ts']);
    expect(buffer.hasFailedWithPrefix('scope-a\0')).toBe(true);
    expect(buffer.hasFailedWithPrefix('scope-b\0')).toBe(false);
    expect(buffer.hasPendingWithPrefix('scope-b\0')).toBe(true);
  });

  it('discards both queued branches after an explicit conflict resolution', () => {
    const buffer = new ReviewDraftHistoryWriteBuffer<number>();
    const key = 'scope-a\0a.ts';
    buffer.enqueue(key, 1);
    const failed = buffer.takeNext(key);
    if (failed === undefined) throw new Error('Expected an in-flight draft');
    buffer.markFailed(key, failed);
    buffer.enqueue(key, 2);

    expect(buffer.resolveConflict(key, false)).toBeUndefined();

    expect(buffer.takeNext(key)).toBeUndefined();
    expect(buffer.keys('scope-a\0')).toEqual([]);
  });

  it('returns the newest queued descendant when recovering the failed branch', () => {
    const buffer = new ReviewDraftHistoryWriteBuffer<number>();
    const key = 'scope-a\0a.ts';
    buffer.markFailed(key, 1);
    buffer.enqueue(key, 2);

    expect(buffer.resolveConflict(key, true)).toBe(2);
    expect(buffer.keys('scope-a\0')).toEqual([]);
  });

  it('records a durably promoted descendant without dropping a newer edit', () => {
    const buffer = new ReviewDraftHistoryWriteBuffer<number>();
    const key = 'scope-a\0a.ts';
    buffer.markFailed(key, 1);
    buffer.enqueue(key, 2);
    const promoted = buffer.peekPending(key);
    if (promoted === undefined) throw new Error('Expected a pending draft');
    buffer.enqueue(key, 3);

    expect(buffer.promotePendingToFailed(key, 1, promoted)).toBe(true);
    expect(buffer.peekFailed(key)).toBe(2);
    expect(buffer.peekPending(key)).toBe(3);
  });
});
