import { handleReviewFileChange } from '@renderer/components/team/review/reviewFileChangeMonitor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewWriteExpectation } from '@renderer/components/team/review/reviewFileChangeMonitor';
import type { ConflictCheckResult } from '@shared/types';

const allEdits = 'const first = 2;\nconst last = 2;\n';
const mixed = 'const first = 2;\nconst last = 1;\n';

function conflict(current: string | null, expected: string): ConflictCheckResult {
  return {
    hasConflict: current !== expected,
    conflictContent: current !== expected ? current : null,
    currentContent: current ?? '',
    originalContent: expected,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function monitor(content: string | null = mixed) {
  let expected: ReviewWriteExpectation | undefined = { expectedContent: content };
  let disk = content;
  let current = true;
  let busy = false;
  const external = vi.fn();
  const check = vi.fn(async (value: string) => conflict(disk, value));
  const wait = vi.fn(async () => { busy = false; });
  const options = {
    isCurrent: () => current,
    isWriteInFlight: () => busy,
    getExpectedWrite: () => expected,
    forgetExpectedWrite: () => { expected = undefined; },
    waitForWrite: wait,
    checkConflict: check,
    onExternalChange: external,
  };
  return {
    options, external, check, wait,
    write(value: string | null) { disk = value; expected = { expectedContent: value }; },
    externalWrite(value: string | null) { disk = value; },
    clear() { expected = undefined; },
    dispose() { current = false; },
    setBusy() { busy = true; },
  };
}

describe('review file notification ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('verifies a delayed own atomic replace instead of expiring it by wall time', async () => {
    vi.useFakeTimers();
    const m = monitor();
    vi.advanceTimersByTime(5001);
    await handleReviewFileChange(m.options);
    expect(m.check).toHaveBeenCalledWith(mixed);
    expect(m.external).not.toHaveBeenCalled();
  });

  it('rechecks the latest committed postimage after an older conflict response', async () => {
    const m = monitor(allEdits);
    const pending = deferred<ConflictCheckResult>();
    m.check.mockImplementationOnce(() => pending.promise);
    const handling = handleReviewFileChange(m.options);
    m.write(mixed);
    pending.resolve(conflict(mixed, allEdits));
    await handling;
    expect(m.check.mock.calls.map(([value]) => value)).toEqual([allEdits, mixed]);
    expect(m.external).not.toHaveBeenCalled();
  });

  it('does not let a response from a disposed review alter its replacement', async () => {
    const m = monitor();
    const pending = deferred<ConflictCheckResult>();
    m.check.mockImplementationOnce(() => pending.promise);
    const handling = handleReviewFileChange(m.options);
    m.dispose();
    pending.resolve(conflict('external\n', mixed));
    await handling;
    expect(m.options.getExpectedWrite()?.expectedContent).toBe(mixed);
    expect(m.external).not.toHaveBeenCalled();
  });

  it('does not suppress external bytes using a matching response for an older postimage', async () => {
    const m = monitor(allEdits);
    const pending = deferred<ConflictCheckResult>();
    m.check.mockImplementationOnce(() => pending.promise);
    const handling = handleReviewFileChange(m.options);
    m.write(mixed);
    m.externalWrite('external\n');
    pending.resolve(conflict(allEdits, allEdits));
    await handling;
    expect(m.check.mock.calls.map(([value]) => value)).toEqual([allEdits, mixed]);
    expect(m.external).toHaveBeenCalledOnce();
  });

  it('waits again if a mutation starts while the authorized check awaits', async () => {
    const m = monitor();
    const pending = deferred<ConflictCheckResult>();
    m.check.mockImplementationOnce(() => pending.promise);
    const handling = handleReviewFileChange(m.options);
    m.setBusy();
    pending.resolve(conflict(mixed, mixed));
    await handling;
    expect(m.wait).toHaveBeenCalledOnce();
    expect(m.check).toHaveBeenCalledTimes(2);
    expect(m.external).not.toHaveBeenCalled();
  });

  it('still flags genuine external bytes even after a long notification delay', async () => {
    vi.useFakeTimers();
    const m = monitor();
    vi.advanceTimersByTime(5001);
    m.externalWrite('external\n');
    await handleReviewFileChange(m.options);
    expect(m.external).toHaveBeenCalledOnce();
    expect(m.options.getExpectedWrite()).toBeUndefined();
  });

  it('waits for the in-flight mutation before checking its postimage', async () => {
    const m = monitor();
    m.setBusy();
    await handleReviewFileChange(m.options);
    expect(m.wait).toHaveBeenCalledOnce();
    expect(m.check).toHaveBeenCalledWith(mixed);
    expect(m.external).not.toHaveBeenCalled();
  });

  it('requires the authorized current disk read to succeed', async () => {
    const m = monitor();
    m.check.mockRejectedValueOnce(new Error('scope revoked'));
    await handleReviewFileChange(m.options);
    expect(m.external).toHaveBeenCalledOnce();
  });

  it('distinguishes own deletion from external recreation and external deletion', async () => {
    const deleted = monitor(null);
    await handleReviewFileChange(deleted.options);
    expect(deleted.external).not.toHaveBeenCalled();
    deleted.externalWrite('recreated\n');
    await handleReviewFileChange(deleted.options);
    expect(deleted.external).toHaveBeenCalledOnce();
    const existing = monitor();
    existing.externalWrite(null);
    await handleReviewFileChange(existing.options);
    expect(existing.external).toHaveBeenCalledOnce();
  });

  it('has no own-write authority after the original scope clears its expectation', async () => {
    const m = monitor();
    m.clear();
    await handleReviewFileChange(m.options);
    expect(m.check).not.toHaveBeenCalled();
    expect(m.external).toHaveBeenCalledOnce();
  });
});
