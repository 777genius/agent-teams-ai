import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleStaleAnthropicTeamApiKeyHelperCleanup,
  STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS,
} from '../TeamProvisioningAnthropicApiKeyHelperCleanup';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TeamProvisioningAnthropicApiKeyHelperCleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules stale helper cleanup with the provisioning retention window', async () => {
    const cleanupStaleHelpers = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };

    scheduleStaleAnthropicTeamApiKeyHelperCleanup({
      baseClaudeDir: '/claude-home',
      cleanupStaleHelpers,
      logger,
    });
    await flushMicrotasks();

    expect(cleanupStaleHelpers).toHaveBeenCalledWith({
      baseClaudeDir: '/claude-home',
      maxAgeMs: STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs cleanup failures without throwing from the scheduler', async () => {
    const cleanupStaleHelpers = vi.fn(async () => {
      throw new Error('disk denied');
    });
    const logger = { warn: vi.fn() };

    const owner = scheduleStaleAnthropicTeamApiKeyHelperCleanup({
      baseClaudeDir: '/claude-home',
      cleanupStaleHelpers,
      logger,
      retryDelaysMs: [24 * 60 * 60 * 1000],
    });
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to cleanup stale Anthropic team API-key helper material: disk denied'
    );
    expect(owner.hasPendingCleanup()).toBe(true);
    expect(owner.getScheduledRetryCount()).toBe(1);
  });

  it('retries the production startup sweep on a bounded schedule and retains exhausted work', async () => {
    vi.useFakeTimers();
    const cleanupStaleHelpers = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('filesystem unavailable'));
    const logger = { warn: vi.fn() };
    const owner = scheduleStaleAnthropicTeamApiKeyHelperCleanup({
      baseClaudeDir: '/claude-home',
      cleanupStaleHelpers,
      logger,
      retryDelaysMs: [10, 20],
    });
    await flushMicrotasks();

    expect(owner.hasPendingCleanup()).toBe(true);
    expect(owner.getScheduledRetryCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(cleanupStaleHelpers).toHaveBeenCalledTimes(3);
    expect(owner.getScheduledRetryCount()).toBe(2);
    expect(owner.hasPendingCleanup()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    cleanupStaleHelpers.mockResolvedValue(undefined);
    await owner.retryNow();

    expect(owner.hasPendingCleanup()).toBe(false);
    expect(cleanupStaleHelpers).toHaveBeenCalledTimes(4);
  });
});
