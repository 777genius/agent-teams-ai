import { describe, expect, it } from 'vitest';

import { inferProviderBillingMode, normalizeProviderBillingMode } from '../providerBillingMode';

describe('providerBillingMode', () => {
  it('normalizes known billing modes only', () => {
    expect(normalizeProviderBillingMode('api')).toBe('api');
    expect(normalizeProviderBillingMode('subscription')).toBe('subscription');
    expect(normalizeProviderBillingMode('free')).toBe('free');
    expect(normalizeProviderBillingMode('unknown')).toBe('unknown');
    expect(normalizeProviderBillingMode('paid')).toBeUndefined();
  });

  it('prefers explicit billing mode over inferred hints', () => {
    expect(
      inferProviderBillingMode({
        explicitBillingMode: 'subscription',
        providerBackendId: 'api',
      })
    ).toBe('subscription');
  });

  it('classifies API billing from backend and auth hints', () => {
    expect(inferProviderBillingMode({ providerBackendId: 'api' })).toBe('api');
    expect(inferProviderBillingMode({ authMethod: 'api_key' })).toBe('api');
    expect(inferProviderBillingMode({ authMethodDetail: 'openrouter_gateway' })).toBe('api');
  });

  it('classifies subscription billing from account auth hints', () => {
    expect(inferProviderBillingMode({ authMethod: 'chatgpt_oauth' })).toBe('subscription');
    expect(inferProviderBillingMode({ backendKind: 'claude.ai_account' })).toBe('subscription');
  });

  it('classifies free routes from model and catalog metadata', () => {
    expect(inferProviderBillingMode({ model: 'provider/model:free' })).toBe('free');
    expect(
      inferProviderBillingMode({
        catalogModel: { metadata: { opencode: { accessKind: 'builtin_free' } } },
      })
    ).toBe('free');
    expect(inferProviderBillingMode({ catalogModel: { badgeLabel: 'Free' } })).toBe('free');
  });

  it('treats authenticated opencode fallback as API and otherwise stays unknown', () => {
    expect(inferProviderBillingMode({ providerId: 'opencode', authenticated: true })).toBe('api');
    expect(inferProviderBillingMode({ providerId: 'codex', model: 'gpt-5.5' })).toBe('unknown');
  });
});
