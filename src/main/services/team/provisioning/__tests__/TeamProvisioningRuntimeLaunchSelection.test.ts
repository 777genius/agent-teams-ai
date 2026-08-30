import { describe, expect, it } from 'vitest';

import { TeamLaunchValidationError } from '../TeamLaunchValidationError';
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

  it('accepts Kimi K3 max and rejects its redundant medium alias', () => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Kimi teammate',
        providerId: 'opencode',
        model: 'kimi-for-coding/k3',
        effort: 'max',
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
        facts: createKimiK3Facts(),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'OpenCode',
      })
    ).toThrow('Kimi K3 does not support it');
  });

  it('rejects catalog effort mismatches with a typed validation error', () => {
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
    ).toThrow(TeamLaunchValidationError);
  });
});

describe('validateRuntimeLaunchSelection typed validation errors', () => {
  const emptyFacts: RuntimeProviderLaunchFacts = {
    defaultModel: null,
    modelIds: new Set(),
    modelListParsed: true,
    modelCatalog: null,
    runtimeCapabilities: null,
  };

  it('rejects a Codex model missing from the live catalog with a typed validation error', () => {
    const run = () =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'codex',
        model: 'gpt-6-codex',
        facts: {
          ...emptyFacts,
          defaultModel: 'gpt-5-codex',
          modelIds: new Set(['gpt-5-codex']),
        },
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Codex',
      });
    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('not present in the live Codex model catalog');
  });

  it('rejects an unverifiable Anthropic effort with a typed validation error', () => {
    const run = () =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        effort: 'xhigh',
        facts: emptyFacts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Claude',
      });
    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('uses Anthropic effort "xhigh"');
  });
});
