import { describe, expect, it } from 'vitest';

import {
  getOpenCodeModelRoutePresentationStatus,
  hasExplicitFreeOpenCodeModelId,
  isOpenCodeLocalProviderId,
  isOpenCodeModelExplicitlyFree,
} from '../opencodeModelRoute';

describe('opencodeModelRoute', () => {
  it('classifies only known on-device providers as local', () => {
    expect(isOpenCodeLocalProviderId('llama.cpp')).toBe(true);
    expect(isOpenCodeLocalProviderId(' OLLAMA ')).toBe(true);
    expect(isOpenCodeLocalProviderId('kiro')).toBe(false);
    expect(isOpenCodeLocalProviderId('cursor-acp')).toBe(false);
  });

  it('uses the model source when partial route metadata omits providerId', () => {
    expect(
      getOpenCodeModelRoutePresentationStatus({
        modelId: 'llama.cpp/qwen-test:0.5b',
        providerId: null,
        routeKind: 'configured_local',
      })
    ).toBe('local');
    expect(
      getOpenCodeModelRoutePresentationStatus({
        modelId: 'kiro/auto',
        providerId: null,
        routeKind: 'configured_local',
      })
    ).toBe('configured');
  });

  it('does not label an unknown configured route as local', () => {
    expect(getOpenCodeModelRoutePresentationStatus({ routeKind: 'configured_local' })).toBe(
      'configured'
    );
  });

  it('classifies connected and builtin-free routes directly', () => {
    expect(getOpenCodeModelRoutePresentationStatus({ routeKind: 'connected_provider' })).toBe(
      'connected'
    );
    expect(getOpenCodeModelRoutePresentationStatus({ routeKind: 'builtin_free' })).toBe('free');
    expect(getOpenCodeModelRoutePresentationStatus({ routeKind: 'catalog_provider' })).toBeNull();
  });

  it('recognizes explicit free model ids', () => {
    expect(hasExplicitFreeOpenCodeModelId('opencode/big-pickle')).toBe(true);
    expect(hasExplicitFreeOpenCodeModelId('openrouter/model:free')).toBe(true);
    expect(hasExplicitFreeOpenCodeModelId('provider/model-free')).toBe(true);
    expect(hasExplicitFreeOpenCodeModelId('provider/free')).toBe(true);
    expect(hasExplicitFreeOpenCodeModelId('openai/gpt-5.6')).toBe(false);
  });

  it('keeps explicit catalog free metadata for catalog routes', () => {
    expect(
      isOpenCodeModelExplicitlyFree({
        modelId: 'community/model',
        routeKind: 'catalog_provider',
        free: true,
      })
    ).toBe(true);
    expect(
      isOpenCodeModelExplicitlyFree({
        modelId: 'community/model',
        routeKind: 'catalog_provider',
        badgeLabel: 'Free',
      })
    ).toBe(true);
  });

  it('ignores stale free metadata on connected and configured routes', () => {
    expect(
      isOpenCodeModelExplicitlyFree({
        modelId: 'openai/gpt-5.6',
        routeKind: 'connected_provider',
        free: true,
        badgeLabel: 'Free',
      })
    ).toBe(false);
    expect(
      isOpenCodeModelExplicitlyFree({
        modelId: 'kiro/auto',
        routeKind: 'configured_local',
        free: true,
      })
    ).toBe(false);
  });

  it('keeps explicitly named free models on connected providers', () => {
    expect(
      isOpenCodeModelExplicitlyFree({
        modelId: 'openrouter/community/model:free',
        routeKind: 'connected_provider',
      })
    ).toBe(true);
  });
});
