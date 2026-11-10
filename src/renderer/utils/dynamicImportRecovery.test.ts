import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerDynamicImportRecovery } from './dynamicImportRecovery';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('registerDynamicImportRecovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents Vite preload errors from reaching React and reloads the renderer once', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = new MemoryStorage();
    const cleanup = registerDynamicImportRecovery({
      now: () => 1_000,
      reload,
      storage,
    });

    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('throttles repeated failed chunk reloads to avoid a reload loop', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = new MemoryStorage();
    const cleanup = registerDynamicImportRecovery({
      now: () => 5_000,
      reload,
      storage,
    });

    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    vi.runOnlyPendingTimers();
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    vi.runOnlyPendingTimers();

    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
