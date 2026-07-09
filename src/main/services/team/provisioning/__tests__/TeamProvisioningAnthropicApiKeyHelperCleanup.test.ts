import { describe, expect, it, vi } from 'vitest';

import {
  scheduleStaleAnthropicTeamApiKeyHelperCleanup,
  STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS,
} from '../TeamProvisioningAnthropicApiKeyHelperCleanup';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TeamProvisioningAnthropicApiKeyHelperCleanup', () => {
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

    scheduleStaleAnthropicTeamApiKeyHelperCleanup({
      baseClaudeDir: '/claude-home',
      cleanupStaleHelpers,
      logger,
    });
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to cleanup stale Anthropic team API-key helper material: disk denied'
    );
  });
});
