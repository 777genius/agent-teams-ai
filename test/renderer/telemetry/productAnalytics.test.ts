import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock('../../../src/renderer/posthog', () => ({
  capturePostHogEvent: posthogMocks.capturePostHogEvent,
}));

import {
  bucketBytes,
  bucketCount,
  bucketDurationMs,
  bucketPromptLength,
  buildProviderMix,
  classifyAnalyticsError,
  normalizeAnalyticsProviderId,
  recordAttachmentAttachEnd,
  recordCrossTeamMessageSend,
  recordProviderConnectionEnd,
  recordProviderOnboardingStepEnd,
  recordReviewApplyEnd,
  recordTaskCreate,
  recordTeamLaunchStepEnd,
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
    expect(bucketBytes(600_000)).toBe('100kb_1mb');
  });

  it('normalizes provider mix to a low-cardinality string', () => {
    expect(normalizeAnalyticsProviderId('github-copilot')).toBe('github-copilot');
    expect(buildProviderMix(['xai', 'codex', 'xai'])).toEqual({
      providerMix: 'codex+xai',
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

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith('provider_setup:connection_end', {
      provider: 'anthropic',
      auth_method: 'browser_session',
      success: false,
      error_class: 'auth',
      duration_ms_bucket: '1_5s',
    });
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

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith('task_management:task_create', {
      source: 'dialog',
      target_type: 'member',
      has_attachments: false,
      has_task_refs: true,
      prompt_length_bucket: '1_200',
      team_size_bucket: '2_5',
    });
    expect(JSON.stringify(posthogMocks.capturePostHogEvent.mock.calls[0])).not.toContain(
      'secret bug'
    );
  });

  it('captures launch step end without raw provider ids outside the whitelist', () => {
    recordTeamLaunchStepEnd({
      step: 'member_spawn',
      success: false,
      durationMs: 17_000,
      memberCount: 6,
      providerIds: ['xai', 'private-provider'],
      errorClass: 'timeout',
      partialFailure: true,
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'team_management:launch_step_end',
      {
        step: 'member_spawn',
        success: false,
        duration_ms_bucket: '15_60s',
        member_count_bucket: '6_10',
        provider_mix: 'xai',
        error_class: 'timeout',
        partial_failure: true,
      }
    );
  });

  it('captures attachment metadata only as buckets and type families', () => {
    recordAttachmentAttachEnd({
      source: 'comment',
      success: true,
      fileCount: 2,
      totalSizeBytes: 600_000,
      mimeTypes: ['image/png', 'application/pdf'],
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'attachment_management:attach_end',
      {
        source: 'comment',
        success: true,
        file_count_bucket: '2_5',
        size_bucket: '100kb_1mb',
        file_type_family: 'mixed',
        error_class: 'none',
      }
    );
  });

  it('captures review apply and provider onboarding step outcomes', () => {
    recordReviewApplyEnd({
      success: false,
      decision: 'request_changes',
      filesCount: 3,
      acceptedCount: 1,
      rejectedCount: 2,
      durationMs: 1_500,
      errorClass: 'permission',
    });
    recordProviderOnboardingStepEnd({
      provider: 'github-copilot',
      step: 'connection_submit',
      success: false,
      durationMs: 1_500,
      errorClass: 'auth',
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenNthCalledWith(1, 'change_review:apply_end', {
      success: false,
      decision: 'request_changes',
      files_count_bucket: '2_5',
      accepted_count_bucket: '1',
      rejected_count_bucket: '2_5',
      duration_ms_bucket: '1_5s',
      error_class: 'permission',
    });
    expect(posthogMocks.capturePostHogEvent).toHaveBeenNthCalledWith(
      2,
      'provider_setup:onboarding_step_end',
      {
        provider: 'github-copilot',
        step: 'connection_submit',
        success: false,
        duration_ms_bucket: '1_5s',
        error_class: 'auth',
      }
    );
  });

  it('captures cross-team message send without message text', () => {
    recordCrossTeamMessageSend({
      source: 'runtime',
      success: true,
      hasReplyTo: true,
      conversationDepth: 4,
      hasTaskRefs: true,
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith('cross_team:message_send', {
      source: 'runtime',
      success: true,
      has_reply_to: true,
      conversation_depth_bucket: '2_5',
      has_task_refs: true,
      error_class: 'none',
    });
  });
});
