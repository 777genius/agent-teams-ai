import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock('../../../src/renderer/posthog', () => ({
  capturePostHogEvent: posthogMocks.capturePostHogEvent,
}));

import {
  bucketCount,
  bucketDurationMs,
  bucketPromptLength,
  buildProviderMix,
  classifyAnalyticsError,
  recordProviderConnectionEnd,
  recordTaskCreate,
} from '../../../src/renderer/analytics/productAnalytics';

describe('product analytics event facade', () => {
  beforeEach(() => {
    posthogMocks.capturePostHogEvent.mockClear();
  });

  it('buckets unbounded values before capture', () => {
    expect(bucketCount(0)).toBe('0');
    expect(bucketCount(4)).toBe('2_5');
    expect(bucketCount(30)).toBe('26_plus');
    expect(bucketDurationMs(700)).toBe('lt_1s');
    expect(bucketDurationMs(8_000)).toBe('5_15s');
    expect(bucketPromptLength(4_500)).toBe('4001_plus');
  });

  it('normalizes provider mix to a low-cardinality string', () => {
    expect(buildProviderMix(['codex', 'anthropic', 'codex'])).toEqual({
      providerMix: 'anthropic+codex',
      hasMixedProviders: true,
    });
    expect(buildProviderMix(['private-provider'])).toEqual({
      providerMix: 'unknown',
      hasMixedProviders: false,
    });
  });

  it('captures provider connection end with sanitized properties', () => {
    recordProviderConnectionEnd({
      provider: 'anthropic',
      authMethod: 'claude.ai',
      success: false,
      errorClass: classifyAnalyticsError(new Error('token expired: secret-token')),
      durationMs: 1_200,
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'provider_setup:connection_end',
      {
        provider: 'anthropic',
        auth_method: 'browser_session',
        success: false,
        error_class: 'auth',
        duration_ms_bucket: '1_5s',
      }
    );
    expect(JSON.stringify(posthogMocks.capturePostHogEvent.mock.calls[0])).not.toContain(
      'secret-token'
    );
  });

  it('captures task creation without raw prompt text', () => {
    recordTaskCreate({
      source: 'dialog',
      targetType: 'member',
      hasAttachments: false,
      hasTaskRefs: true,
      promptLength: 'fix the secret bug'.length,
      teamSize: 3,
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'task_management:task_create',
      {
        source: 'dialog',
        target_type: 'member',
        has_attachments: false,
        has_task_refs: true,
        prompt_length_bucket: '1_200',
        team_size_bucket: '2_5',
      }
    );
    expect(JSON.stringify(posthogMocks.capturePostHogEvent.mock.calls[0])).not.toContain(
      'secret bug'
    );
  });
});
