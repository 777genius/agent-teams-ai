import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProviderActivityStatusStrip } from '@renderer/components/common/ProviderActivityStatusStrip';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: ({ providerId }: { providerId: string }) =>
    React.createElement('span', { 'data-testid': `provider-logo-${providerId}` }, providerId),
}));

function createProvider(
  overrides: Partial<CliProviderStatus> & {
    providerId: CliProviderId;
    displayName: string;
  }
): CliProviderStatus {
  const { providerId, displayName, ...rest } = overrides;
  return {
    providerId,
    displayName,
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'verified',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelVerificationState: 'idle',
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
    availableBackends: [],
    connection: null,
    ...rest,
  };
}

function createMultimodelStatus(providers: CliProviderStatus[]): CliInstallationStatus {
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: '0.0.3',
    binaryPath: '/tmp/claude-multimodel',
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: providers.some((provider) => provider.authenticated === true),
    authStatusChecking: false,
    authMethod: null,
    providers,
  };
}

function renderStrip(
  host: HTMLElement,
  props: Partial<React.ComponentProps<typeof ProviderActivityStatusStrip>> & {
    cliStatus: CliInstallationStatus | null;
  }
): ReturnType<typeof createRoot> {
  const root = createRoot(host);
  root.render(
    React.createElement(ProviderActivityStatusStrip, {
      sourceCliStatus: props.cliStatus,
      cliStatusLoading: false,
      cliProviderStatusLoading: {},
      multimodelEnabled: true,
      ...props,
    })
  );
  return root;
}

describe('ProviderActivityStatusStrip', () => {
  it.each([
    ['codex', true],
    ['codex', false],
    ['opencode', true],
  ] as const)(
    'shows Ready only with complete launch authority (%s teamLaunch=%s)',
    async (providerId, teamLaunch) => {
      const provider = createProvider({
        providerId,
        displayName: 'Codex',
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        modelCatalogRefreshState: 'ready',
      });
      provider.capabilities.teamLaunch = teamLaunch;
      provider.modelCatalog = {
        schemaVersion: 1,
        providerId,
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2020-01-01T00:00:00.000Z',
        staleAt: '2100-01-01T00:00:00.000Z',
        defaultModelId: 'model',
        defaultLaunchModel: 'model',
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        models: [
          {
            id: 'model',
            launchModel: 'model',
            displayName: 'Model',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
        ],
      };
      const host = document.createElement('div');
      let root!: ReturnType<typeof createRoot>;
      await act(async () => {
        root = renderStrip(host, {
          cliStatus: createMultimodelStatus([
            providerId === 'opencode'
              ? { ...provider, modelCatalogRefreshState: 'loading' }
              : provider,
          ]),
          providerStatusOverride: providerId === 'opencode' ? provider : null,
          cliProviderStatusLoading: providerId === 'opencode' ? { opencode: true } : {},
          showReadyProviders: true,
          readyStatusText: 'Ready',
        });
      });
      expect(host.textContent?.includes('Ready')).toBe(teamLaunch);
      if (!teamLaunch) expect(host.textContent).toContain('Needs attention');
      await act(async () => root.unmount());
    }
  );

  it('shows OpenCode ready when selected scoped catalogs settle passive discovery', async () => {
    const passiveProvider = createProvider({
      providerId: 'opencode',
      displayName: 'OpenCode',
      authenticated: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      statusCheckErrorCode: 'partial_response',
      modelCatalogRefreshState: 'loading',
    });
    passiveProvider.capabilities.teamLaunch = false;
    const scopedProvider = createProvider({
      providerId: 'opencode',
      displayName: 'OpenCode',
      authenticated: true,
      statusCheckOutcome: 'authoritative',
      modelCatalogRefreshState: 'ready',
    });
    scopedProvider.modelCatalog = {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2020-01-01T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: 'openrouter/auto',
      defaultLaunchModel: 'openrouter/auto',
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: [
        {
          id: 'openrouter/auto',
          launchModel: 'openrouter/auto',
          displayName: 'Auto',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
    };
    const host = document.createElement('div');
    let root!: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderStrip(host, {
        cliStatus: createMultimodelStatus([passiveProvider]),
        providerStatusOverride: passiveProvider,
        openCodePreparationEvidence: {
          selectedModels: ['openrouter/auto'],
          scopedStatusBySourceId: new Map([['openrouter', scopedProvider]]),
        },
        showReadyProviders: true,
        readyStatusText: 'Ready',
      });
    });

    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).toContain('Ready');
    expect(host.textContent).not.toContain('Checking...');
    expect(host.textContent).not.toContain('Needs attention');
    await act(async () => root.unmount());
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows loading providers', async () => {
    const cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);

    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = renderStrip(host, {
        cliStatus,
        cliProviderStatusLoading: { anthropic: true },
      });
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Provider Activity');
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Checking...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('filters to selected provider ids', async () => {
    const cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);

    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = renderStrip(host, {
        cliStatus,
        cliProviderStatusLoading: { anthropic: true, codex: true },
        providerIds: ['codex'],
      });
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Anthropic');
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Checking...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('never marks finished but unauthorized providers Checked or hides their blockers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderActivityStatusStrip, {
          cliStatus: createMultimodelStatus([
            createProvider({
              providerId: 'anthropic',
              displayName: 'Anthropic',
              verificationState: 'unknown',
              statusMessage: 'Checking...',
            }),
            createProvider({
              providerId: 'codex',
              displayName: 'Codex',
              verificationState: 'unknown',
              statusMessage: 'Checking...',
            }),
          ]),
          sourceCliStatus: null,
          cliStatusLoading: false,
          cliProviderStatusLoading: { anthropic: true, codex: true },
          multimodelEnabled: true,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        React.createElement(ProviderActivityStatusStrip, {
          cliStatus: createMultimodelStatus([
            createProvider({
              providerId: 'anthropic',
              displayName: 'Anthropic',
              verificationState: 'verified',
              statusMessage: 'Not connected',
            }),
            createProvider({
              providerId: 'codex',
              displayName: 'Codex',
              verificationState: 'unknown',
              statusMessage: 'Checking...',
            }),
          ]),
          sourceCliStatus: null,
          cliStatusLoading: false,
          cliProviderStatusLoading: { anthropic: false, codex: true },
          multimodelEnabled: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).not.toContain('Checked');
    expect(host.textContent).toContain('Needs attention');
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Checking...');

    await act(async () => {
      root.render(
        React.createElement(ProviderActivityStatusStrip, {
          cliStatus: createMultimodelStatus([
            createProvider({
              providerId: 'anthropic',
              displayName: 'Anthropic',
              verificationState: 'verified',
              statusMessage: 'Not connected',
            }),
            createProvider({
              providerId: 'codex',
              displayName: 'Codex',
              verificationState: 'verified',
              statusMessage: 'ChatGPT account ready',
              authenticated: true,
              authMethod: 'chatgpt',
            }),
          ]),
          sourceCliStatus: null,
          cliStatusLoading: false,
          cliProviderStatusLoading: { anthropic: false, codex: false },
          multimodelEnabled: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Needs attention');
    expect(host.textContent).not.toContain('catalog');
    expect(host.textContent).not.toContain('Checked');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('stays visible for provider errors after loading finishes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = renderStrip(host, {
        cliStatus: createMultimodelStatus([
          createProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            verificationState: 'error',
            statusMessage: 'Failed to refresh anthropic status',
          }),
        ]),
      });
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Needs attention');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not mask finished Codex native provider errors as model loading', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = renderStrip(host, {
        cliStatus: createMultimodelStatus([
          createProvider({
            providerId: 'codex',
            displayName: 'Codex',
            supported: true,
            verificationState: 'error',
            statusMessage: 'Failed to refresh Codex status',
            backend: {
              kind: 'codex-native',
              label: 'Codex native',
              endpointLabel: 'codex exec --json',
            },
            models: [],
            modelAvailability: [],
          }),
        ]),
      });
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Needs attention');
    expect(host.textContent).not.toContain('Checking...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('masks a negative Codex bootstrap state while source placeholder loading is still active', async () => {
    const sourceCliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    const cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'error',
        statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        connection: {
          supportsOAuth: false,
          supportsApiKey: true,
          configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
          configuredAuthMode: 'chatgpt',
          apiKeyConfigured: false,
          apiKeySource: null,
          codex: {
            preferredAuthMode: 'chatgpt',
            effectiveAuthMode: null,
            launchAllowed: false,
            launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
            launchReadinessState: 'missing_auth',
            appServerState: 'healthy',
            appServerStatusMessage: null,
            managedAccount: null,
            requiresOpenaiAuth: true,
            localAccountArtifactsPresent: false,
            localActiveChatgptAccountPresent: false,
            login: {
              status: 'idle',
              error: null,
              startedAt: null,
            },
            rateLimits: null,
          },
        },
      }),
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);

    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = renderStrip(host, {
        cliStatus,
        sourceCliStatus,
      });
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain(
      'Connect a ChatGPT account to use your Codex subscription.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
