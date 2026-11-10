import { describe, expect, it } from 'vitest';

import {
  buildCodexFastModeArgs,
  resolveCodexFastMode,
  resolveCodexRuntimeSelection,
} from '../../../src/features/codex-runtime-profile/core/domain/resolveCodexRuntimeProfile';

import type { CliProviderModelCatalog, CliProviderStatus } from '../../../src/shared/types';

function makeCodexCatalog(overrides?: Partial<CliProviderModelCatalog>): CliProviderModelCatalog {
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-04-21T00:00:00.000Z',
    staleAt: '2026-04-21T00:01:00.000Z',
    defaultModelId: 'gpt-5.4',
    defaultLaunchModel: 'gpt-5.4',
    models: [
      {
        id: 'gpt-5.4',
        launchModel: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
      {
        id: 'gpt-5.4-mini',
        launchModel: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 Mini',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      },
      {
        id: 'gpt-5.5',
        launchModel: 'gpt-5.5',
        displayName: 'GPT-5.5',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        supportsPersonality: false,
        supportsFastMode: true,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      },
    ],
    diagnostics: {
      configReadState: 'ready',
      appServerState: 'healthy',
    },
    ...overrides,
  };
}

function makeProviderStatus(overrides?: Partial<CliProviderStatus>): Partial<CliProviderStatus> {
  return {
    providerId: 'codex',
    authenticated: true,
    authMethod: 'chatgpt',
    selectedBackendId: 'codex-native',
    resolvedBackendId: 'codex-native',
    backend: {
      kind: 'codex-native',
      label: 'Codex',
    },
    models: ['gpt-5.4', 'gpt-5.4-mini'],
    modelCatalog: makeCodexCatalog(),
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
      configuredAuthMode: 'chatgpt',
      apiKeyConfigured: false,
      apiKeySource: null,
      codex: {
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: 'chatgpt',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        requiresOpenaiAuth: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed: true,
        launchIssueMessage: null,
        launchReadinessState: 'ready_chatgpt',
      },
    },
    ...overrides,
  };
}

describe('resolveCodexRuntimeProfile', () => {
  it('allows explicit Fast for GPT-5.4 with ChatGPT auth on codex-native', () => {
    const selection = resolveCodexRuntimeSelection({
      source: { providerStatus: makeProviderStatus() },
      selectedModel: 'gpt-5.4',
    });
    const fast = resolveCodexFastMode({ selection, selectedFastMode: 'on' });

    expect(fast).toMatchObject({
      selectedFastMode: 'on',
      requestedFastMode: true,
      resolvedFastMode: true,
      selectable: true,
      disabledReason: null,
      capabilitySource: 'static-fallback',
      creditCostMultiplier: 2,
      speedMultiplier: 1.5,
    });
  });

  it('allows explicit Fast for future catalog-declared Fast-capable models without changing static policy', () => {
    const selection = resolveCodexRuntimeSelection({
      source: { providerStatus: makeProviderStatus() },
      selectedModel: 'gpt-5.5',
    });
    const fast = resolveCodexFastMode({ selection, selectedFastMode: 'on' });

    expect(fast).toMatchObject({
      selectedFastMode: 'on',
      requestedFastMode: true,
      resolvedFastMode: true,
      selectable: true,
      disabledReason: null,
      capabilitySource: 'model-catalog',
    });
  });

  it('keeps inherit safely off even when GPT-5.4 is eligible', () => {
    const selection = resolveCodexRuntimeSelection({
      source: { providerStatus: makeProviderStatus() },
      selectedModel: 'gpt-5.4',
    });
    const fast = resolveCodexFastMode({ selection, selectedFastMode: 'inherit' });

    expect(fast.selectable).toBe(true);
    expect(fast.requestedFastMode).toBe(false);
    expect(fast.resolvedFastMode).toBe(false);
  });

  it('disables Fast for API key mode with an API pricing reason', () => {
    const providerStatus = makeProviderStatus({
      authMethod: 'api_key',
      connection: {
        ...makeProviderStatus().connection!,
        codex: {
          ...makeProviderStatus().connection!.codex!,
          effectiveAuthMode: 'api_key',
          launchReadinessState: 'ready_api_key',
        },
      },
    });
    const selection = resolveCodexRuntimeSelection({
      source: { providerStatus },
      selectedModel: 'gpt-5.4',
    });
    const fast = resolveCodexFastMode({ selection, selectedFastMode: 'on' });

    expect(fast.selectable).toBe(false);
    expect(fast.resolvedFastMode).toBe(false);
    expect(fast.disabledReason).toContain('API key mode uses standard API pricing');
  });

  it('disables Fast for models that do not expose Fast support', () => {
    const selection = resolveCodexRuntimeSelection({
      source: { providerStatus: makeProviderStatus() },
      selectedModel: 'gpt-5.4-mini',
    });
    const fast = resolveCodexFastMode({ selection, selectedFastMode: 'on' });

    expect(fast.selectable).toBe(false);
    expect(fast.capabilitySource).toBe('unavailable');
    expect(fast.disabledReason).toContain('not available for GPT-5.4 Mini');
  });

  it('disables Fast when catalog truth is degraded or missing', () => {
    const degraded = resolveCodexRuntimeSelection({
      source: {
        providerStatus: makeProviderStatus({
          modelCatalog: makeCodexCatalog({ status: 'degraded' }),
        }),
      },
      selectedModel: 'gpt-5.4',
    });
    const missing = resolveCodexRuntimeSelection({
      source: {
        providerStatus: makeProviderStatus({
          modelCatalog: null,
        }),
      },
      selectedModel: 'gpt-5.4',
    });

    expect(resolveCodexFastMode({ selection: degraded, selectedFastMode: 'on' }).selectable).toBe(
      false
    );
    expect(resolveCodexFastMode({ selection: missing, selectedFastMode: 'on' }).selectable).toBe(
      false
    );
  });

  it('builds official per-run Codex fast config overrides only for resolved Fast', () => {
    expect(buildCodexFastModeArgs(true)).toEqual([
      '--settings',
      JSON.stringify({
        codex: {
          agent_teams_launch_config: {
            config_overrides: ['service_tier="fast"', 'features.fast_mode=true'],
          },
        },
      }),
    ]);
    expect(buildCodexFastModeArgs(false)).toEqual([]);
    expect(buildCodexFastModeArgs(null)).toEqual([]);
  });
});
