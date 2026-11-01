import {
  inferOpenCodeProviderAuthMethod,
  isOpenCodeProviderConnectionBlocked as isBlocked,
  resolveOpenCodeProviderCompatibility as resolve,
} from '../../../../src/features/runtime-provider-management/core/domain/openCodeProviderCompatibility';
import { describe, expect, it } from 'vitest';

describe('OpenCode provider generation compatibility', () => {
  it.each([
    ['cursor', 'cli-plugin'], ['cursor-acp', 'cli-plugin'], ['kiro', 'cli-plugin'],
    ['supergrok', 'subscription-oauth'], ['github-copilot', 'subscription-oauth'],
  ] as const)('identifies unadapted V2 route %s without claiming an upstream defect', (id, reason) => {
    expect(resolve(id, 'v2')).toEqual({ state: 'incompatible', reason, canConnect: false });
    expect(resolve(id, 'v1')).toEqual({ state: 'supported', reason: null, canConnect: true });
  });

  it.each([
    'kimi-code-membership', 'kimi-for-coding', 'kimi-code-plan-cn',
    'kimi-code-plan-global', 'zai-coding-plan', 'minimax-token-plan',
    'minimax-coding-plan', 'xiaomi-mimo-token-plan', 'xiaomi-token-plan-sgp',
    'openrouter', 'vercel', 'openai-plus-pro', 'openai', 'xai',
    'a-user-defined-provider',
  ])('never claims unproven V2 model execution for %s', (id) => {
    expect(resolve(id, 'v2')).toEqual({ state: 'unverified', reason: null, canConnect: true });
  });

  it('does not confuse the SuperGrok subscription with the xAI API-key provider', () => {
    expect(resolve('supergrok', 'v2').canConnect).toBe(false);
    expect(resolve('xai', 'v2').canConnect).toBe(true);
    expect(resolve('xai', 'v2', 'api').canConnect).toBe(true);
    expect(resolve('xai', 'v2', 'oauth')).toEqual({
      state: 'incompatible', reason: 'subscription-oauth', canConnect: false,
    });
  });

  it('blocks xAI OAuth-only catalog rows while keeping xAI API-key connection available', () => {
    expect(inferOpenCodeProviderAuthMethod(['oauth'])).toBe('oauth');
    expect(inferOpenCodeProviderAuthMethod(['oauth', 'oauth'])).toBe('oauth');
    expect(inferOpenCodeProviderAuthMethod(['oauth', 'api'])).toBeNull();
    expect(inferOpenCodeProviderAuthMethod(['api'])).toBeNull();
    expect(resolve('xai', 'v2', inferOpenCodeProviderAuthMethod(['oauth'])).canConnect).toBe(false);
    expect(resolve('xai', 'v2', inferOpenCodeProviderAuthMethod(['api'])).canConnect).toBe(true);
  });

  it('does not count an unknown V1 provider as a supported integration', () => {
    expect(resolve('another-provider', 'v1').state).toBe('unverified');
    expect(resolve('OPENROUTER', 'v1').state).toBe('supported');
  });
});

describe('OpenCode advanced connection action policy', () => {
  it('fails closed during unknown native runtime status but not for unscoped older callers', () => {
    expect(isBlocked('xai', null, 'api')).toBe(true);
    expect(isBlocked('kiro', null)).toBe(true);
    expect(isBlocked('xai', undefined, 'api')).toBe(false);
  });
  it('allows xAI API keys while rejecting xAI subscription OAuth on V2', () => {
    expect(isBlocked('xai', 'v2', 'api')).toBe(false);
    expect(isBlocked('xai', 'v2', 'oauth')).toBe(true);
    expect(isBlocked('cursor-acp', 'v2')).toBe(true);
    expect(isBlocked('xai', 'v1', 'oauth')).toBe(false);
  });
});
