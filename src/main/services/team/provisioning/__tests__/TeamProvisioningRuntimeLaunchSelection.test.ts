import { describe, expect, it } from 'vitest';

import {
  buildProviderModelLaunchIdentity,
  normalizeProvisioningModelCheckRequests,
  validateRuntimeLaunchSelection,
} from '../TeamProvisioningRuntimeLaunchSelection';

import type { RuntimeProviderLaunchFacts } from '../TeamProvisioningRuntimeLaunchSelection';

const explicitProvenance = {
  version: 1 as const,
  providerBackendId: 'default' as const,
  model: 'explicit' as const,
  effort: 'explicit' as const,
};

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

function createKimiK3Facts(): RuntimeProviderLaunchFacts {
  return {
    defaultModel: 'kimi-for-coding/k3',
    modelIds: new Set(['kimi-for-coding/k3']),
    modelListParsed: true,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-07-20T10:00:00.000Z',
      staleAt: '2026-07-20T10:10:00.000Z',
      defaultModelId: 'kimi-for-coding/k3',
      defaultLaunchModel: 'kimi-for-coding/k3',
      models: [
        {
          id: 'kimi-for-coding/k3',
          launchModel: 'kimi-for-coding/k3',
          displayName: 'Kimi K3',
          hidden: false,
          supportedReasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image', 'video'],
          supportsPersonality: true,
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
  it('pins concrete default snapshots when catalog defaults change after proof', () => {
    const facts = createKimiK3Facts();
    facts.defaultModel = 'new/default';
    facts.modelIds.add('proved/default');
    facts.modelIds.add('new/default');
    facts.modelCatalog = {
      ...facts.modelCatalog!,
      defaultModelId: 'new/default',
      defaultLaunchModel: 'new/default',
      models: [
        ...facts.modelCatalog!.models.map((model) => ({ ...model, isDefault: false })),
        {
          ...facts.modelCatalog!.models[0],
          id: 'proved/default',
          launchModel: 'proved/default',
          defaultReasoningEffort: 'low',
          isDefault: false,
        },
        {
          ...facts.modelCatalog!.models[0],
          id: 'new/default',
          launchModel: 'new/default',
          defaultReasoningEffort: 'max',
          isDefault: true,
        },
      ],
    };

    const identity = buildProviderModelLaunchIdentity({
      request: {
        providerId: 'opencode',
        providerBackendId: 'opencode-cli',
        model: 'proved/default',
        effort: 'low',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'default',
          effort: 'default',
        },
      },
      facts,
      anthropicFastModeDefault: false,
    });

    expect(identity).toMatchObject({
      providerBackendId: 'opencode-cli',
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: 'proved/default',
      selectedEffort: null,
      resolvedEffort: 'low',
    });
  });

  it('preserves Anthropic null and backend-separated identical checks', () => {
    expect(
      normalizeProvisioningModelCheckRequests([
        { providerId: 'codex', providerBackendId: 'adapter', model: 'gpt-5', effort: 'high' },
        { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5', effort: 'high' },
        { providerId: 'anthropic', providerBackendId: null, model: 'claude-sonnet-4-5' },
      ])
    ).toEqual([
      { providerId: 'codex', providerBackendId: 'adapter', model: 'gpt-5', effort: 'high' },
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5', effort: 'high' },
      { providerId: 'anthropic', providerBackendId: null, model: 'claude-sonnet-4-5' },
    ]);
  });

  it.each(['xhigh', 'max'] as const)('accepts exact Kiro catalog effort %s', (effort) => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kiro teammate',
        providerId: 'opencode',
        model: 'kiro/auto',
        effort,
        leadRuntimeSelectionProvenance: explicitProvenance,
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
        leadRuntimeSelectionProvenance: explicitProvenance,
        facts: createKiroFacts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).toThrow('Kiro Auto does not support it');
  });

  it('accepts Kimi K3 max and rejects its redundant medium alias', () => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kimi teammate',
        providerId: 'opencode',
        model: 'kimi-for-coding/k3',
        effort: 'max',
        leadRuntimeSelectionProvenance: explicitProvenance,
        facts: createKimiK3Facts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).not.toThrow();
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kimi teammate',
        providerId: 'opencode',
        model: 'kimi-for-coding/k3',
        effort: 'medium',
        leadRuntimeSelectionProvenance: explicitProvenance,
        facts: createKimiK3Facts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).toThrow('Kimi K3 does not support it');
  });
});
