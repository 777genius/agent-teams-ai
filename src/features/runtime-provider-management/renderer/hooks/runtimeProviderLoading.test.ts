// @vitest-environment node
import {
  OPENCODE_LOADING_TIMEOUT_MS,
  PROVIDER_CLI_TIMEOUT_MS,
  PROVIDER_UI_TIMEOUT_MS,
} from '@shared/constants/runtimeLoading';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withUiTimeout } from './runtimeProviderManagementInternals';

describe('provider loading timeout ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the UI outside loading, existing catalog lease and CLI cleanup', () => {
    expect(OPENCODE_LOADING_TIMEOUT_MS).toBe(180_000);
    expect(PROVIDER_CLI_TIMEOUT_MS).toBe(300_000);
    expect(PROVIDER_UI_TIMEOUT_MS).toBe(330_000);
  });

  it('accepts slow loading after the previous 70-second and three-minute cutoffs', async () => {
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    const result = withUiTimeout(pending, 'TEST loading timed out').finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(180_001);
    expect(settled).toBe(false);
    finish('loaded');
    await expect(result).resolves.toBe('loaded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still stops waiting at the finite outer deadline', async () => {
    let settled = false;
    const result = withUiTimeout(new Promise<never>(() => {}), 'TEST timeout')
      .then(
        () => 'unexpected',
        (error: Error) => error.message
      )
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(PROVIDER_UI_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('TEST timeout');
  });

  it('honors a deliberate shorter override', async () => {
    const result = withUiTimeout(new Promise<never>(() => {}), 'TEST short timeout', 500).then(
      () => 'unexpected',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe('TEST short timeout');
  });

  it('returns actual errors immediately and clears the timer', async () => {
    const failure = new Error('TEST cancelled');
    await expect(withUiTimeout(Promise.reject(failure), 'TEST timeout')).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
