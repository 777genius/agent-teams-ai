import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_PROVIDER_ONBOARDING_PLANS } from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderOnboarding';
import { RuntimeProviderOnboardingView } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderOnboardingView';

import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';
import type {
  RuntimeProviderOnboardingActions,
  RuntimeProviderOnboardingState,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderOnboarding';

function managementState(
  overrides: Partial<RuntimeProviderManagementState> = {}
): RuntimeProviderManagementState {
  return {
    view: null,
    providers: [],
    selectedProviderId: null,
    providerQuery: '',
    directoryLoading: false,
    directoryRefreshing: false,
    directoryError: null,
    directoryErrorDiagnostics: null,
    directoryEntries: [],
    directoryTotalCount: null,
    directoryNextCursor: null,
    directoryLoaded: true,
    directorySummary: false,
    directorySelectedProviderId: null,
    directorySupported: true,
    activeFormProviderId: null,
    connectionIntent: null,
    setupForm: null,
    setupFormLoading: false,
    setupFormError: null,
    setupFormErrorDiagnostics: null,
    setupSubmitError: null,
    setupSubmitErrorDiagnostics: null,
    setupMetadata: {},
    apiKeyValue: '',
    selectedAuthOptionId: null,
    oauthProgress: null,
    oauthCodeValue: '',
    modelPickerProviderId: null,
    modelPickerMode: null,
    modelQuery: '',
    models: [],
    modelsLoading: false,
    modelsError: null,
    modelsErrorDiagnostics: null,
    selectedModelId: null,
    testingModelIds: [],
    savingDefaultModelId: null,
    modelResults: {},
    loading: false,
    savingProviderId: null,
    error: null,
    errorDiagnostics: null,
    successMessage: null,
    ...overrides,
  };
}

function managementActions(): RuntimeProviderManagementActions {
  return {
    refresh: vi.fn(async () => undefined),
    selectProvider: vi.fn(),
    setProviderQuery: vi.fn(),
    loadMoreDirectory: vi.fn(async () => undefined),
    refreshDirectory: vi.fn(async () => undefined),
    selectDirectoryProvider: vi.fn(),
    searchAllProviders: vi.fn(),
    startConnect: vi.fn(),
    startReconnect: vi.fn(),
    cancelConnect: vi.fn(),
    setApiKeyValue: vi.fn(),
    setAuthOption: vi.fn(),
    setSetupMetadataValue: vi.fn(),
    setOAuthCodeValue: vi.fn(),
    submitOAuthCode: vi.fn(async () => undefined),
    submitConnect: vi.fn(async () => ({ verifiedModelId: null })),
    forgetProvider: vi.fn(async () => undefined),
    openProviderCredentialPage: vi.fn(async () => undefined),
    openModelPicker: vi.fn(),
    closeModelPicker: vi.fn(),
    setModelQuery: vi.fn(),
    selectModel: vi.fn(),
    useModelForNewTeams: vi.fn(),
    testModel: vi.fn(async (providerId: string, modelId: string) => ({
      providerId,
      modelId,
      ok: true,
      availability: 'available' as const,
      message: 'Model probe passed',
      diagnostics: [],
    })),
    setDefaultModel: vi.fn(async () => undefined),
  };
}

function onboardingState(
  overrides: Partial<RuntimeProviderOnboardingState> = {}
): RuntimeProviderOnboardingState {
  return {
    mode: 'wizard',
    plans: RUNTIME_PROVIDER_ONBOARDING_PLANS,
    selectedPlanIds: ['supergrok', 'zai-coding-plan', 'minimax-token-plan', 'github-copilot'],
    wizardStarted: false,
    resumable: false,
    progress: null,
    activePlan: null,
    planStatuses: RUNTIME_PROVIDER_ONBOARDING_PLANS.map((plan) => ({
      plan,
      state: 'pending' as const,
    })),
    stage: 'connect',
    stageError: null,
    recommendedModel: null,
    verifiedModelId: null,
    runtimeGate: 'ready',
    runtimeUpdateRequired: false,
    runtimePreparing: false,
    management: managementState(),
    ...overrides,
  };
}

function onboardingActions(
  overrides: Partial<RuntimeProviderOnboardingActions> = {}
): RuntimeProviderOnboardingActions {
  return {
    management: managementActions(),
    togglePlan: vi.fn(),
    startWizard: vi.fn(async () => undefined),
    restartWizard: vi.fn(),
    installOrUpdateRuntime: vi.fn(async () => undefined),
    beginConnect: vi.fn(),
    beginVerification: vi.fn(),
    submitConnect: vi.fn(async () => true),
    verifyModel: vi.fn(async () => undefined),
    acceptVerifiedModel: vi.fn(),
    openCredentialPage: vi.fn(async () => undefined),
    clearCompletedWizard: vi.fn(),
    ...overrides,
  };
}

describe('RuntimeProviderOnboardingView', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('lets the user select plans before starting the resumable wizard', async () => {
    const startWizard = vi.fn(async () => undefined);
    const togglePlan = vi.fn();
    const advanced = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState(),
          actions: onboardingActions({ startWizard, togglePlan }),
          onAdvancedSettings: advanced,
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('Connect all my plans');
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(8);
    const startButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Start setup'
    );
    act(() => startButton?.click());
    expect(startWizard).toHaveBeenCalledTimes(1);

    const advancedButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Advanced settings')
    );
    act(() => advancedButton?.click());
    expect(advanced).toHaveBeenCalledTimes(1);
  });

  it('asks before spending quota to verify an already connected plan', async () => {
    const beginVerification = vi.fn();
    const beginConnect = vi.fn();
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find((candidate) => candidate.id === 'supergrok')!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: ['supergrok'],
            activePlan: plan,
            management: managementState({
              directoryEntries: [
                {
                  providerId: 'xai',
                  displayName: 'xAI',
                  state: 'connected',
                  connectedAuthHint: 'oauth',
                  setupKind: 'connected',
                  ownership: ['managed'],
                  recommended: true,
                  modelCount: 1,
                  authMethods: ['oauth'],
                  defaultModelId: 'xai/grok-4.3',
                  sources: ['inventory'],
                  sourceLabel: 'OpenCode',
                  providerSource: null,
                  detail: null,
                  actions: [],
                  metadata: {
                    hasKnownModels: true,
                    requiresManualConfig: false,
                    supportedInlineAuth: true,
                    configuredAuthless: false,
                  },
                },
              ],
            }),
          }),
          actions: onboardingActions({ beginVerification, beginConnect }),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('This plan is already connected');
    expect(host.textContent).toContain('Verification sends one short model request');
    const buttons = [...host.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent?.includes('Verify and choose'))?.click());
    expect(beginVerification).toHaveBeenCalledTimes(1);
    expect(beginConnect).not.toHaveBeenCalled();
  });

  it('shows a verified provider as ready without returning to the provider catalog', async () => {
    const done = vi.fn();
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: [plan.id],
            activePlan: plan,
            stage: 'ready',
            verifiedModelId: 'xai/grok-4.3',
          }),
          actions: onboardingActions(),
          onAdvancedSettings: vi.fn(),
          onDone: done,
        })
      );
    });

    expect(host.textContent).toContain('Ready for Agent Teams');
    expect(host.textContent).not.toContain('Browse all providers');
    const doneButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Done'
    );
    act(() => doneButton?.click());
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('offers the official subscription key page for key-based plans', async () => {
    const openCredentialPage = vi.fn(async () => undefined);
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find(
      (entry) => entry.id === 'minimax-token-plan'
    )!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: [plan.id],
            activePlan: plan,
            stage: 'connect',
            management: managementState({ setupFormLoading: true }),
          }),
          actions: onboardingActions({ openCredentialPage }),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    const keyButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open subscription key page')
    );
    act(() => keyButton?.click());
    expect(openCredentialPage).toHaveBeenCalledTimes(1);
  });

  it('shows provider setup loading immediately while the directory is still resolving', async () => {
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: [plan.id],
            activePlan: plan,
            stage: 'connect',
            management: managementState({
              directoryLoading: true,
              directoryLoaded: false,
            }),
          }),
          actions: onboardingActions(),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('Loading provider setup...');
    expect(host.querySelector('[data-testid="runtime-provider-onboarding"]')).not.toBeNull();
    const connectButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Connect'
    );
    expect(connectButton?.disabled).toBe(true);
  });

  it('closes onboarding when provider setup is cancelled', async () => {
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    const cancelConnect = vi.fn();
    const onDone = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: [plan.id],
            activePlan: plan,
            stage: 'connect',
            management: managementState({
              activeFormProviderId: plan.providerId,
              setupFormLoading: true,
            }),
          }),
          actions: onboardingActions({
            management: {
              ...managementActions(),
              cancelConnect,
            },
          }),
          onAdvancedSettings: vi.fn(),
          onDone,
        })
      );
    });

    const cancelButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    );
    act(() => cancelButton?.click());

    expect(cancelConnect).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offers reconnect after a saved credential fails live verification', async () => {
    const beginConnect = vi.fn();
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            selectedPlanIds: [plan.id],
            activePlan: plan,
            stage: 'error',
            stageError: 'Refresh token has been revoked',
            management: managementState({
              models: [
                {
                  modelId: 'xai/grok-4.3',
                  providerId: 'xai',
                  displayName: 'Grok 4.3',
                  sourceLabel: 'OpenCode',
                  free: false,
                  default: true,
                  availability: 'unavailable',
                },
              ],
            }),
          }),
          actions: onboardingActions({ beginConnect }),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    const reconnectButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Reconnect plan'
    );
    act(() => reconnectButton?.click());
    expect(beginConnect).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Retry verification');
  });

  it('shows the OpenCode preparation error and offers a retry', async () => {
    const installOrUpdateRuntime = vi.fn(async () => undefined);
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            activePlan: plan,
            selectedPlanIds: [plan.id],
            runtimeGate: 'error',
            stage: 'error',
            stageError: 'OpenCode download failed. Check your connection.',
          }),
          actions: onboardingActions({ installOrUpdateRuntime }),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('OpenCode setup needs attention');
    expect(host.textContent).toContain('OpenCode download failed. Check your connection.');
    const retryButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry OpenCode'
    );
    await act(async () => retryButton?.click());
    expect(installOrUpdateRuntime).toHaveBeenCalledTimes(1);
  });

  it('keeps installation progress explicit after an OpenCode update starts', async () => {
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS[0]!;
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            activePlan: plan,
            selectedPlanIds: [plan.id],
            runtimeGate: 'installing',
            runtimePreparing: true,
          }),
          actions: onboardingActions(),
          onAdvancedSettings: vi.fn(),
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('Installing OpenCode');
    expect(host.textContent).toContain(
      'Installing the managed OpenCode runtime. This window updates automatically.'
    );
    expect(host.textContent).not.toContain('OpenCode is required');
  });

  it('routes providers without guided setup to Advanced settings without a false success', async () => {
    const onAdvancedSettings = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingView, {
          state: onboardingState({
            mode: 'provider',
            activePlan: null,
            stage: 'error',
            stageError: 'This provider is only available in Advanced settings.',
          }),
          actions: onboardingActions(),
          onAdvancedSettings,
          onDone: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('Use Advanced settings for this provider');
    expect(host.textContent).not.toContain('All selected plans are ready');
    const advancedButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Advanced settings')
    );
    act(() => advancedButton?.click());
    expect(onAdvancedSettings).toHaveBeenCalledTimes(1);
  });
});
