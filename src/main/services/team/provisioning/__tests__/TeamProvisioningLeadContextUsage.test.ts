import { describe, expect, it } from 'vitest';

import {
  buildLeadContextUsagePayloadFromState,
  getInitialLeadContextWindowTokensForRequest,
} from '../TeamProvisioningLeadContextUsage';

describe('lead context usage helpers', () => {
  it('builds an unavailable payload when no usage state exists', () => {
    expect(buildLeadContextUsagePayloadFromState(null, '2026-01-01T00:00:00.000Z')).toEqual({
      promptInputTokens: null,
      outputTokens: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextUsedPercent: null,
      promptInputSource: 'unavailable',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('calculates and clamps context usage percent', () => {
    expect(
      buildLeadContextUsagePayloadFromState(
        {
          promptInputTokens: 100,
          outputTokens: 10,
          contextUsedTokens: 15_000,
          contextWindowTokens: 10_000,
          promptInputSource: 'anthropic_usage',
        },
        '2026-01-01T00:00:00.000Z'
      ).contextUsedPercent
    ).toBe(100);

    expect(
      buildLeadContextUsagePayloadFromState(
        {
          promptInputTokens: 100,
          outputTokens: 10,
          contextUsedTokens: 2_500,
          contextWindowTokens: 10_000,
          promptInputSource: 'anthropic_usage',
        },
        '2026-01-01T00:00:00.000Z'
      ).contextUsedPercent
    ).toBe(25);
  });

  it('infers an Anthropic default context window when model is omitted', () => {
    expect(
      getInitialLeadContextWindowTokensForRequest({
        providerId: 'anthropic',
        limitContext: false,
      })
    ).toBeGreaterThan(0);
  });
});
