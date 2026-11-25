import { describe, expect, it, vi } from 'vitest';

import { createRetainedLegacyResource } from '../../../src/features/agent-backend/renderer/retainedLegacyResource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('retained original runtime read snapshots', () => {
  it('shares one pending read and clears both consumers before a manual refresh completes', async () => {
    const first = deferred<{ account: string }>();
    const second = deferred<{ account: string }>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const resource = createRetainedLegacyResource<{ account: string }>(load);
    const observedA: unknown[] = [], observedB: unknown[] = [];
    const unsubscribe = resource.subscribe(() => { observedA.push(resource.getSnapshot()); });
    resource.subscribe(() => { observedB.push(resource.getSnapshot()); });

    const initial = resource.ensure();
    expect(resource.ensure()).toBe(initial);
    expect(resource.refresh()).toBe(initial);
    expect(resource.getSnapshot()).toEqual({ value: null, loading: true, error: null });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve({ account: 'TEST-original-account' });
    expect(await initial).toBe(true);
    expect(resource.getSnapshot().value).toEqual({ account: 'TEST-original-account' });
    expect(await resource.ensure()).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    const refreshed = resource.refresh();
    expect(resource.getSnapshot()).toEqual({ value: null, loading: true, error: null });
    expect(observedA.at(-1)).toBe(resource.getSnapshot());
    expect(observedB.at(-1)).toBe(resource.getSnapshot());
    unsubscribe();
    const aCount = observedA.length;
    second.resolve({ account: 'TEST-current-original-account' });
    expect(await refreshed).toBe(true);
    expect(resource.getSnapshot().value).toEqual({ account: 'TEST-current-original-account' });
    expect(observedA).toHaveLength(aCount);
    expect(observedB.at(-1)).toBe(resource.getSnapshot());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('removes prior authority on failure and only retries when refresh is explicitly requested', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ launchAllowed: true })
      .mockRejectedValueOnce(new Error('TEST-original-status-unavailable'))
      .mockResolvedValueOnce({ launchAllowed: false });
    const resource = createRetainedLegacyResource<{ launchAllowed: boolean }>(load);
    expect(await resource.ensure()).toBe(true);
    expect(resource.getSnapshot().value?.launchAllowed).toBe(true);
    expect(await resource.refresh()).toBe(false);
    expect(resource.getSnapshot()).toEqual({ value: null, loading: false, error: 'TEST-original-status-unavailable' });
    expect(await resource.ensure()).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await resource.refresh()).toBe(true);
    expect(resource.getSnapshot()).toEqual({ value: { launchAllowed: false }, loading: false, error: null });
  });

  it('cannot publish a pending response after the original choice is retired', async () => {
    const response = deferred<{ launchAllowed: true }>();
    const load = vi.fn(() => response.promise);
    const resource = createRetainedLegacyResource(load);
    const pending = resource.ensure();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    resource.retire();
    const retired = resource.getSnapshot();
    expect(retired.value).toBeNull();
    expect(retired.loading).toBe(false);
    expect(retired.error).toMatch(/closed/);
    response.resolve({ launchAllowed: true });
    expect(await pending).toBe(false);
    expect(resource.getSnapshot()).toBe(retired);
    expect(await resource.refresh()).toBe(false);
    expect(await resource.ensure()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not start new reads for a resource retired before its first consumer', async () => {
    const load = vi.fn(async () => ({ privateModel: 'TEST-original-model' }));
    const resource = createRetainedLegacyResource(load);
    resource.retire();
    expect(await resource.ensure()).toBe(false);
    expect(await resource.refresh()).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(resource.getSnapshot().value).toBeNull();
  });
});
