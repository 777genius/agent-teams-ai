import { describe, expect, it } from 'vitest';

import {
  getOptionDisplayLabel,
  getProviderRuntimeBackendAudienceLabel,
  getProviderRuntimeBackendStateLabel,
  getProviderRuntimeBackendSummary,
  getVisibleProviderRuntimeBackendOptions,
} from '@renderer/components/runtime/ProviderRuntimeBackendSelector';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderStatus } from '@shared/types';

function createCodexProvider(
  overrides?: Partial<CliProviderStatus>
): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'oauth_token',
    verificationState: 'verified',
    statusMessage: 'Connected',
    models: ['gpt-5-codex'],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: 'codex-native',
    resolvedBackendId: 'codex-native',
    availableBackends: [
      {
        id: 'auto',
        label: 'Auto',
        description: 'Automatically choose the best backend.',
        selectable: true,
        recommended: true,
        available: true,
        state: 'ready',
        audience: 'general',
      },
      {
        id: 'codex-native',
        label: 'Codex native',
        description: 'Use the local codex exec JSON seam.',
        selectable: false,
        recommended: false,
        available: true,
        state: 'locked',
        audience: 'internal',
        statusMessage: 'Ready but locked',
        detailMessage: 'Internal rollout only.',
      },
    ],
    externalRuntimeDiagnostics: [],
    backend: {
      kind: 'codex-native',
      label: 'Codex native',
    },
    connection: null,
    ...overrides,
  };
}

describe('ProviderRuntimeBackendSelector helpers', () => {
  it('exposes explicit internal-audience and locked-state labels', () => {
    const provider = createCodexProvider();
    const option = provider.availableBackends?.find((backend) => backend.id === 'codex-native');

    expect(option).toBeDefined();
    expect(getProviderRuntimeBackendAudienceLabel(option!)).toBe('Internal');
    expect(getProviderRuntimeBackendStateLabel(option!)).toBe('Locked');
  });

  it('builds a runtime summary that keeps internal locked truth visible', () => {
    const provider = createCodexProvider();

    expect(getProviderRuntimeBackendSummary(provider)).toBe(
      'Codex native - internal - locked'
    );
  });

  it('shows auth-required state for degraded internal native rollout', () => {
    const provider = createCodexProvider({
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use the local codex exec JSON seam.',
          selectable: false,
          recommended: false,
          available: false,
          state: 'authentication-required',
          audience: 'internal',
          statusMessage: 'Authentication required',
          detailMessage: 'Set CODEX_API_KEY.',
        },
      ],
    });
    const option = provider.availableBackends?.[0];

    expect(getProviderRuntimeBackendAudienceLabel(option!)).toBe('Internal');
    expect(getProviderRuntimeBackendStateLabel(option!)).toBe('Auth required');
    expect(getProviderRuntimeBackendSummary(provider)).toBe(
      'Codex native - internal - auth required'
    );
  });

  it('hides codex legacy fallbacks from normal selectors when native is selected', () => {
    const provider = createCodexProvider({
      availableBackends: [
        {
          id: 'auto',
          label: 'Auto',
          description: 'Automatically choose the best backend.',
          selectable: true,
          recommended: false,
          available: true,
          state: 'ready',
          audience: 'general',
        },
        {
          id: 'api',
          label: 'OpenAI API',
          description: 'Legacy public Responses API fallback.',
          selectable: true,
          recommended: false,
          available: true,
          state: 'ready',
          audience: 'internal',
        },
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use the local codex exec JSON seam.',
          selectable: true,
          recommended: true,
          available: true,
          state: 'ready',
          audience: 'general',
        },
      ],
    });

    expect(getVisibleProviderRuntimeBackendOptions(provider).map((option) => option.id)).toEqual([
      'codex-native',
    ]);
  });

  it('keeps an explicitly selected legacy codex fallback readable during the soak', () => {
    const provider = createCodexProvider({
      selectedBackendId: 'api',
      resolvedBackendId: 'api',
      availableBackends: [
        {
          id: 'api',
          label: 'OpenAI API',
          description: 'Legacy public Responses API fallback.',
          selectable: true,
          recommended: false,
          available: true,
          state: 'ready',
          audience: 'internal',
        },
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'Use the local codex exec JSON seam.',
          selectable: true,
          recommended: true,
          available: true,
          state: 'ready',
          audience: 'general',
        },
      ],
    });
    const visibleOptions = getVisibleProviderRuntimeBackendOptions(provider);

    expect(visibleOptions.map((option) => option.id)).toEqual(['api', 'codex-native']);
    expect(getOptionDisplayLabel(provider, visibleOptions[0], null)).toBe(
      'Legacy OpenAI fallback'
    );
    expect(getProviderRuntimeBackendSummary(provider)).toBe('Legacy OpenAI fallback - internal');
  });
});
