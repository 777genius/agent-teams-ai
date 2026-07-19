import { describe, expect, it } from 'vitest';

import { validateRuntimeLaunchSelection } from '../TeamProvisioningRuntimeLaunchSelection';

import type { RuntimeProviderLaunchFacts } from '../TeamProvisioningRuntimeLaunchSelection';

function createKiroFacts(): RuntimeProviderLaunchFacts {
  return {
    defaultModel: 'kiro/auto',
    modelIds: new Set(['kiro/auto']),
    modelListParsed: true,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-07-19T10:00:00.000Z',
      staleAt: '2026-07-19T10:10:00.000Z',
      defaultModelId: 'kiro/auto',
      defaultLaunchModel: 'kiro/auto',
      models: [
        {
          id: 'kiro/auto',
          launchModel: 'kiro/auto',
          displayName: 'Kiro Auto',
          hidden: false,
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    runtimeCapabilities: null,
  };
}

describe('validateRuntimeLaunchSelection OpenCode catalog effort', () => {
  it.each(['xhigh', 'max'] as const)('accepts exact Kiro catalog effort %s', (effort) => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kiro teammate',
        providerId: 'opencode',
        model: 'kiro/auto',
        effort,
        facts: createKiroFacts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).not.toThrow();
  });

  it('rejects an effort omitted by the exact Kiro catalog model', () => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kiro teammate',
        providerId: 'opencode',
        model: 'kiro/auto',
        effort: 'ultra',
        facts: createKiroFacts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).toThrow('Kiro Auto does not support it');
  });
});
