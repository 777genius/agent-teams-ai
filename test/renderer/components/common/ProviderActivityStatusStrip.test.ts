import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProviderActivityStatusStrip } from '@renderer/components/common/ProviderActivityStatusStrip';
import { hasCapturedTeamLaunchReadiness } from '@renderer/components/team/dialogs/capturedTeamLaunchReadiness';
import {
  createProviderSubmissionFence,
  getPendingProviderPreflightIds,
} from '@renderer/components/team/dialogs/optionalProviderPreflight';
import { createLaunchGuard } from '@renderer/components/team/dialogs/providerLaunchAuthority';
import { ProviderLaunchAuthorityNotice } from '@renderer/components/team/dialogs/ProviderLaunchAuthorityNotice';
import { useCapturedTeamLaunchReadiness } from '@renderer/components/team/dialogs/useCapturedTeamLaunchReadiness';
import { capturedTeamSelectionSignature } from '@shared/utils/capturedTeamReadiness';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProvisioningProviderCheck } from '@renderer/components/team/dialogs/provisioningProviderChecks';
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';
import type { Mock } from 'vitest';

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
    'refresh',
    'auth',
    'unsupported',
    'error',
    'catalog-error',
    'unavailable',
    'mixed',
  ] as const)(
    'presents authenticated Anthropic catalog refresh neutrally without hiding %s failures',
    async (scenario) => {
      const provider = createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        authenticated: scenario !== 'auth',
        supported: scenario !== 'unsupported',
        verificationState: scenario === 'error' ? 'error' : 'verified',
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: scenario === 'unavailable' ? 'unavailable' : undefined,
        modelCatalogRefreshState: scenario === 'catalog-error' ? 'error' : 'loading',
        models: ['claude-haiku-4-5'],
      });
      provider.capabilities.teamLaunch = false;
      const providers =
        scenario === 'mixed'
          ? [
              provider,
              createProvider({
                providerId: 'opencode',
                displayName: 'OpenCode',
                verificationState: 'error',
              }),
            ]
          : [provider];
      const guard = createLaunchGuard(
        scenario === 'mixed' ? ['anthropic', 'opencode'] : ['anthropic'],
        new Map(providers.map((entry) => [entry.providerId, entry]))
      );
      expect(guard.blocked(true)).toBe(true);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(ProviderActivityStatusStrip, {
              cliStatus: createMultimodelStatus(providers),
              cliStatusLoading: false,
              cliProviderStatusLoading: {},
              multimodelEnabled: true,
              showReadyProviders: true,
            }),
            React.createElement(ProviderLaunchAuthorityNotice, {
              action: 'launch',
              blockers: guard.blockers(true),
              id: 'provider-refresh-notice',
              onOpenProviderSettings: vi.fn(),
            })
          )
        );
      });
      if (scenario === 'refresh') {
        expect(host.textContent).toContain('Checking...');
        expect(host.querySelector('#provider-refresh-notice')?.getAttribute('role')).toBe('status');
        expect(host.textContent).not.toContain('Needs attention');
        expect(host.querySelector('[role="alert"]')).toBeNull();
      } else {
        expect(host.textContent).toContain('Needs attention');
        expect(host.querySelector('#provider-refresh-notice')?.getAttribute('role')).toBe('alert');
        if (scenario === 'mixed') {
          expect(host.querySelector('#provider-refresh-notice')?.textContent).toMatch(
            /Anthropic.*checking/i
          );
        }
      }
      await act(async () => root.unmount());
    }
  );

  it.each([
    ['codex', true],
    ['codex', false],
    ['opencode', true],
    ['anthropic', true],
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
            ...(providerId !== 'codex'
              ? [
                  createProvider({
                    providerId: 'codex',
                    displayName: 'Codex',
                    statusCheckOutcome: 'pending',
                    statusCheckErrorCode: 'partial_response',
                    verificationState: 'unknown',
                  }),
                ]
              : []),
          ]),
          providerStatusOverride: providerId === 'opencode' ? provider : null,
          cliProviderStatusLoading: providerId === 'opencode' ? { opencode: true } : {},
          showReadyProviders: true,
          readyStatusText: 'Ready',
          forceLoadingProviderIds: getPendingProviderPreflightIds(
            'loading',
            providerId === 'codex' ? [providerId] : [providerId, 'codex'],
            [
              { providerId, status: 'ready', details: [] },
              ...(providerId !== 'codex'
                ? [{ providerId: 'codex' as const, status: 'pending' as const, details: [] }]
                : []),
            ]
          ),
        });
      });
      expect(host.textContent?.includes('Ready')).toBe(teamLaunch);
      if (!teamLaunch) expect(host.textContent).toContain('Needs attention');
      if (providerId !== 'codex') {
        expect(
          host.querySelector(`[data-testid="provider-activity-status-${providerId}"]`)?.textContent
        ).toContain('Ready');
        expect(
          host.querySelector('[data-testid="provider-activity-status-codex"]')?.textContent
        ).toContain('Checking...');
      }
      await act(async () => root.unmount());
    }
  );

  it.each([
    'draft',
    'team',
    'preparation',
    'selection',
    'expired',
    'closed',
    'text-only',
    'failed',
    'loading',
  ] as const)('presents only current captured Team readiness through %s changes', async (scenario) => {
    const now = 2_000_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const scope = {
      teamName: 'host-team:TEST-handle',
      preparationId: 'TEST-preparation',
      selectionSignature: 'TEST-selection',
      draftSignature: 'TEST-current-draft',
      open: true,
    };
    const proof = {
      handleId: 'TEST-handle',
      preparationId: scope.preparationId,
      selectionSignature: scope.selectionSignature,
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-source',
      expiresAt: now + 60_000,
    };
    const check: ProvisioningProviderCheck = {
      providerId: 'codex',
      status: 'ready',
      details: ['TEST selected model ready'],
      capturedTeamDraftSignature: scope.draftSignature,
      capturedTeamReadiness: proof,
    };
    const provider = createProvider({
      providerId: 'codex',
      displayName: 'Codex',
      verificationState: 'error',
      statusMessage: 'TEST global discovery is unavailable',
    });
    const cliStatus = createMultimodelStatus([
      provider,
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'error',
      }),
    ]);
    const originalStatus = JSON.stringify(cliStatus);
    const permits = (providerId: CliProviderId, at: number) =>
      hasCapturedTeamLaunchReadiness(scope, [check], providerId, at);
    const statuses = new Map([['codex' as const, provider]]);
    const guard = createLaunchGuard(['codex'], statuses, undefined, { permits });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (loading = false) => {
      await act(async () => {
        root.render(
          React.createElement(ProviderActivityStatusStrip, {
            cliStatus,
            sourceCliStatus: cliStatus,
            cliStatusLoading: false,
            cliProviderStatusLoading: {},
            multimodelEnabled: true,
            hasCapturedTeamReadiness: (providerId, at) => permits(providerId, at),
            forceLoadingProviderIds: loading ? ['codex'] : undefined,
            showReadyProviders: true,
            readyStatusText: 'Ready',
          })
        );
      });
    };
    try {
      await render();
      const chip = () => host.querySelector('[data-testid="provider-activity-status-codex"]');
      expect(chip()?.getAttribute('data-tone')).toBe('checked');
      expect(chip()?.textContent).toContain('Ready');
      expect(chip()?.textContent).not.toContain('Needs attention');
      expect(guard.blocked(true)).toBe(false);
      expect(createLaunchGuard(['codex'], statuses).blocked(true)).toBe(true);
      expect(
        host.querySelector('[data-testid="provider-activity-status-anthropic"]')?.getAttribute('data-tone')
      ).toBe('error');

      switch (scenario) {
        case 'draft':
          scope.draftSignature = 'TEST-edited-draft';
          break;
        case 'team':
          scope.teamName = 'host-team:TEST-other-handle';
          break;
        case 'preparation':
          scope.preparationId = 'TEST-other-preparation';
          break;
        case 'selection':
          scope.selectionSignature = 'TEST-other-selection';
          break;
        case 'expired':
          clock.mockReturnValue(proof.expiresAt);
          break;
        case 'closed':
          scope.open = false;
          break;
        case 'text-only':
          delete check.capturedTeamReadiness;
          break;
        case 'failed':
          check.status = 'failed';
          break;
        case 'loading':
          break;
      }
      await render(scenario === 'loading');
      expect(chip()?.getAttribute('data-tone')).toBe(scenario === 'loading' ? 'loading' : 'error');
      expect(chip()?.textContent).toContain(scenario === 'loading' ? 'Checking...' : 'Needs attention');
      expect(chip()?.textContent).not.toContain('Ready');
      expect(guard.blocked(true)).toBe(scenario !== 'loading');
      expect(createLaunchGuard(['codex'], statuses).blocked(true)).toBe(true);
      expect(JSON.stringify(cliStatus)).toBe(originalStatus);
    } finally {
      await act(async () => root.unmount());
      clock.mockRestore();
    }
  });

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

  it('keeps a selected provider neutral while a detailed preflight is still running', async () => {
    const provider = createProvider({
      providerId: 'opencode',
      displayName: 'OpenCode',
      verificationState: 'error',
      statusMessage: 'Provider launch status could not be verified.',
    });
    const host = document.createElement('div');
    let root!: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderStrip(host, {
        cliStatus: createMultimodelStatus([provider]),
        providerStatusOverride: provider,
        forceLoadingProviderIds: ['opencode'],
        showReadyProviders: true,
      });
    });

    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain('Needs attention');
    await act(async () => root.unmount());
  });

  it('shows concise provider details only when requested', async () => {
    const provider = createProvider({
      providerId: 'codex',
      displayName: 'Codex',
      authenticated: true,
      statusCheckOutcome: 'authoritative',
      modelCatalogRefreshState: 'ready',
      statusMessage: 'Codex native runtime ready',
    });
    provider.modelCatalog = {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2020-01-01T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: 'model',
      defaultLaunchModel: 'model',
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: [],
    };
    const host = document.createElement('div');
    let root!: ReturnType<typeof createRoot>;

    await act(async () => {
      root = renderStrip(host, {
        cliStatus: createMultimodelStatus([provider]),
        showReadyProviders: true,
        showDetailMessages: true,
      });
    });

    expect(host.querySelector('[data-testid="provider-activity-detail-codex"]')?.textContent).toBe(
      'Codex native runtime ready'
    );
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
    // Light-first colors with dark variants keep the chip readable in both themes.
    const chip = host.querySelector('[data-testid="provider-activity-status-anthropic"]');
    expect(chip?.getAttribute('data-tone')).toBe('error');
    expect(chip?.className).toContain('text-red-800');
    expect(chip?.className).toContain('dark:text-red-100');
    expect(chip?.getAttribute('style')).toBeNull();

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

  it('reuses render observation time until the real captured readiness owner expires', async () => {
    const now = 2_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fence = createProviderSubmissionFence();
    const selectedModelChecks = [{ providerId: 'codex' as const, model: 'TEST-model' }];
    const cwd = '/tmp/TEST-captured-readiness';
    let checks: ProvisioningProviderCheck[] = [];
    const observed: {
      readiness?: ReturnType<typeof useCapturedTeamLaunchReadiness>;
      permits?: Mock<(providerId: string, at: number) => boolean>;
      rerenderChild?: () => void;
    } = {};
    const provider = createProvider({
      providerId: 'codex',
      displayName: 'Codex',
      verificationState: 'error',
    });
    const cliStatus = createMultimodelStatus([provider]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const chip = () => host.querySelector('[data-testid="provider-activity-status-codex"]');
    function Child({
      permits,
    }: {
      permits: ReturnType<typeof useCapturedTeamLaunchReadiness>['permits'];
    }): React.JSX.Element {
      const [, invalidate] = React.useState(0);
      React.useLayoutEffect(() => {
        observed.rerenderChild = () => invalidate((value) => value + 1);
      }, []);
      return React.createElement(ProviderActivityStatusStrip, {
        cliStatus,
        sourceCliStatus: cliStatus,
        cliStatusLoading: false,
        // A child render must invalidate the provider-state memo, not only its label.
        cliProviderStatusLoading: {},
        multimodelEnabled: true,
        hasCapturedTeamReadiness: permits,
        showReadyProviders: true,
        readyStatusText: 'Ready',
      });
    }
    function Harness(): React.JSX.Element {
      const readiness = useCapturedTeamLaunchReadiness({
        sourceRevision: 'TEST-source',
        open: true,
        teamName: 'host-team:TEST-handle',
        preparationId: fence.preparationId,
        cwd,
        selectedModelChecks,
        limitContext: false,
        draft: 'TEST-current-draft',
        checks,
        fence,
      });
      const permits = React.useMemo(() => vi.fn(readiness.permits), [readiness.permits]);
      React.useLayoutEffect(() => {
        observed.readiness = readiness;
        observed.permits = permits;
      });
      return React.createElement(Child, { permits });
    }
    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(chip()?.getAttribute('data-tone')).toBe('error');
      checks = [
        {
          providerId: 'codex',
          status: 'ready',
          details: [],
          capturedTeamDraftSignature: observed.readiness!.draftSignature,
          capturedTeamReadiness: {
            handleId: 'TEST-handle',
            preparationId: fence.preparationId,
            selectionSignature: capturedTeamSelectionSignature({
              cwd,
              selectedModelChecks,
              limitContext: false,
            }),
            launchId: 'TEST-launch',
            rosterRevision: 'TEST-roster',
            expiresAt: now + 1_000,
          },
        },
      ];
      await act(async () => root.render(React.createElement(Harness)));
      expect(chip()?.getAttribute('data-tone')).toBe('checked');
      const originalPermits = observed.permits!;
      originalPermits.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(250);
        observed.rerenderChild!();
      });
      expect(observed.permits).toBe(originalPermits);
      expect(originalPermits.mock.calls.length).toBeGreaterThan(0);
      expect(
        originalPermits.mock.calls.every(([providerId, at]) => providerId === 'codex' && at === now)
      ).toBe(true);
      expect(chip()?.getAttribute('data-tone')).toBe('checked');
      const guard = createLaunchGuard(
        ['codex'],
        new Map([['codex' as const, provider]]),
        undefined,
        observed.readiness
      );
      expect(guard.blocked(true)).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(750);
      });
      expect(Date.now()).toBe(now + 1_000);
      // The original expiry+1 callback is still pending; action-time authority already refuses.
      expect(guard.blocked(true)).toBe(true);
      expect(observed.permits).toBe(originalPermits);
      expect(chip()?.getAttribute('data-tone')).toBe('checked');
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(observed.permits).not.toBe(originalPermits);
      expect(chip()?.getAttribute('data-tone')).toBe('error');
      expect(chip()?.textContent).not.toContain('Ready');
      expect(
        observed.permits!.mock.calls.some(
          ([providerId, at]) => providerId === 'codex' && at === now + 1_001
        )
      ).toBe(true);
      expect(guard.blocked(true)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });
});
