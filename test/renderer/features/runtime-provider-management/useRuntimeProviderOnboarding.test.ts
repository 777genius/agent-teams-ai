import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
} from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderOnboarding';
import {
  type RuntimeProviderOnboardingActions,
  type RuntimeProviderOnboardingState,
  useRuntimeProviderOnboarding,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderOnboarding';

import type { RuntimeProviderDirectoryEntryDto } from '../../../../src/features/runtime-provider-management/contracts';
import type { RuntimeProviderOnboardingProgressRepository } from '../../../../src/features/runtime-provider-management/renderer/adapters/runtimeProviderOnboardingProgressRepository';
import type { ElectronAPI } from '../../../../src/shared/types/api';

function directoryEntry(
  providerId: string,
  state: 'connected' | 'available',
  connectedAuthHint: string | null = null,
  configuredAuthless = false
): RuntimeProviderDirectoryEntryDto {
  return {
    providerId,
    displayName: providerId,
    state,
    connectedAuthHint,
    setupKind: state === 'connected' ? 'connected' : 'connect-api-key',
    ownership: state === 'connected' ? ['managed'] : [],
    recommended: true,
    modelCount: 1,
    authMethods: state === 'connected' ? ['oauth'] : ['api'],
    defaultModelId: null,
    sources: ['inventory'],
    sourceLabel: 'OpenCode',
    providerSource: 'inventory',
    detail: null,
    actions: [],
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: true,
      configuredAuthless,
    },
  };
}

function directoryResponse(entries: readonly RuntimeProviderDirectoryEntryDto[]) {
  return {
    schemaVersion: 1 as const,
    runtimeId: 'opencode' as const,
    directory: {
      runtimeId: 'opencode' as const,
      totalCount: entries.length,
      returnedCount: entries.length,
      query: null,
      filter: 'all' as const,
      limit: 100,
      cursor: null,
      nextCursor: null,
      entries,
      diagnostics: [],
      fetchedAt: new Date(0).toISOString(),
    },
  };
}

describe('useRuntimeProviderOnboarding', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let currentState: RuntimeProviderOnboardingState | null = null;
  let currentActions: RuntimeProviderOnboardingActions | null = null;
  let repository: RuntimeProviderOnboardingProgressRepository;
  let savedProgress: ReturnType<typeof createRuntimeProviderOnboardingProgress> | null;
  let loadProviderDirectory: ReturnType<typeof vi.fn>;
  let loadSetupForm: ReturnType<typeof vi.fn>;
  let loadModels: ReturnType<typeof vi.fn>;
  let testModel: ReturnType<typeof vi.fn>;

  function Harness({
    mode = 'provider',
    providerId = 'xai',
    runtimeGate = 'ready',
    runtimeUpdateRequired = false,
    onInstall = vi.fn(),
  }: {
    mode?: 'provider' | 'wizard';
    providerId?: string | null;
    runtimeGate?: 'ready' | 'missing';
    runtimeUpdateRequired?: boolean;
    onInstall?: () => Promise<void> | void;
  }) {
    [currentState, currentActions] = useRuntimeProviderOnboarding({
      enabled: true,
      mode,
      providerId,
      projectPath: '/tmp/agent-teams-provider-onboarding-test',
      runtimeGate,
      runtimeUpdateRequired,
      onInstallOrUpdateRuntime: onInstall,
      progressRepository: repository,
    });
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    savedProgress = null;
    repository = {
      load: vi.fn(() => savedProgress),
      save: vi.fn((progress) => {
        savedProgress = progress;
      }),
      clear: vi.fn(() => {
        savedProgress = null;
      }),
    };
    loadProviderDirectory = vi.fn(async () =>
      directoryResponse([directoryEntry('xai', 'connected', 'oauth')])
    );
    loadSetupForm = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      setupForm: {
        runtimeId: 'opencode' as const,
        providerId: 'minimax-coding-plan',
        displayName: 'MiniMax Token Plan',
        method: 'api' as const,
        supported: true,
        title: 'Connect MiniMax Token Plan',
        description: null,
        submitLabel: 'Connect',
        disabledReason: null,
        source: 'curated' as const,
        secret: {
          key: 'key' as const,
          label: 'Subscription Key',
          placeholder: 'sk-cp-...',
          required: true,
        },
        prompts: [],
      },
    }));
    loadModels = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      models: {
        runtimeId: 'opencode' as const,
        providerId: 'xai',
        defaultModelId: 'xai/grok-4.3',
        diagnostics: [],
        models: [
          {
            modelId: 'xai/grok-4.3',
            providerId: 'xai',
            displayName: 'Grok 4.3',
            sourceLabel: 'OpenCode',
            free: false,
            default: true,
            availability: 'untested' as const,
          },
        ],
      },
    }));
    testModel = vi.fn(async (input: { providerId: string; modelId: string }) => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: input.providerId,
        modelId: input.modelId,
        ok: true,
        availability: 'available' as const,
        message: 'Model probe passed',
        diagnostics: [],
      },
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadProviderDirectory,
          loadSetupForm,
          loadModels,
          testModel,
          loadView: vi.fn(),
          connectProvider: vi.fn(),
          connectWithApiKey: vi.fn(),
          forgetCredential: vi.fn(),
          setDefaultModel: vi.fn(),
          submitOAuthCode: vi.fn(async () => ({ ok: true })),
          cancelOAuth: vi.fn(async () => ({ ok: true })),
          onOAuthProgress: vi.fn(() => vi.fn()),
        },
        openExternal: vi.fn(async () => ({ success: true })),
      } as unknown as ElectronAPI,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, 'electronAPI');
    vi.unstubAllGlobals();
    currentState = null;
    currentActions = null;
  });

  it('skips credential entry for a connected plan and verifies a recommended model', async () => {
    await act(async () => root.render(React.createElement(Harness)));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect({
      stage: currentState?.stage,
      activePlan: currentState?.activePlan?.id,
      directoryLoaded: currentState?.management.directoryLoaded,
      directoryError: currentState?.management.directoryError,
      modelPickerProviderId: currentState?.management.modelPickerProviderId,
      modelsLoading: currentState?.management.modelsLoading,
      modelsError: currentState?.management.modelsError,
    }).toMatchObject({ stage: 'choose-model' });

    expect(loadSetupForm).not.toHaveBeenCalled();
    expect(loadModels).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'xai' }));
    expect(testModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'xai', modelId: 'xai/grok-4.3' })
    );
    expect(currentState?.verifiedModelId).toBe('xai/grok-4.3');

    await act(async () => currentActions?.acceptVerifiedModel());
    expect(currentState?.stage).toBe('ready');
  });

  it('verifies Cursor through its existing CLI session instead of requesting an API key', async () => {
    loadProviderDirectory.mockResolvedValue(
      directoryResponse([directoryEntry('cursor-acp', 'available', null, true)])
    );
    loadModels.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      models: {
        runtimeId: 'opencode' as const,
        providerId: 'cursor-acp',
        defaultModelId: 'cursor-acp/auto',
        diagnostics: [],
        models: [
          {
            modelId: 'cursor-acp/auto',
            providerId: 'cursor-acp',
            displayName: 'Auto',
            sourceLabel: 'managed OpenCode plugin',
            free: false,
            default: true,
            availability: 'untested' as const,
          },
        ],
      },
    });

    await act(async () => root.render(React.createElement(Harness, { providerId: 'cursor-acp' })));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(loadSetupForm).not.toHaveBeenCalled();
    expect(testModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'cursor-acp', modelId: 'cursor-acp/auto' })
    );
    expect(currentState?.stage).toBe('choose-model');
    expect(currentState?.verifiedModelId).toBe('cursor-acp/auto');
  });

  it('verifies Kiro through its companion CLI route instead of reopening plugin OAuth', async () => {
    loadProviderDirectory.mockResolvedValue(
      directoryResponse([directoryEntry('kiro', 'available', null, true)])
    );
    loadModels.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      models: {
        runtimeId: 'opencode' as const,
        providerId: 'kiro',
        defaultModelId: 'kiro/auto',
        diagnostics: [],
        models: [
          {
            modelId: 'kiro/auto',
            providerId: 'kiro',
            displayName: 'Auto',
            sourceLabel: 'managed OpenCode plugin',
            free: false,
            default: true,
            availability: 'untested' as const,
          },
        ],
      },
    });

    await act(async () => root.render(React.createElement(Harness, { providerId: 'kiro' })));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(loadSetupForm).not.toHaveBeenCalled();
    expect(testModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'kiro', modelId: 'kiro/auto' })
    );
    expect(currentState?.stage).toBe('choose-model');
    expect(currentState?.verifiedModelId).toBe('kiro/auto');
  });

  it('opens the curated Kimi membership setup for the focused quick-connect flow', async () => {
    loadProviderDirectory.mockResolvedValueOnce(
      directoryResponse([directoryEntry('kimi-for-coding', 'available')])
    );

    await act(async () =>
      root.render(
        React.createElement(Harness, {
          mode: 'provider',
          providerId: 'kimi-for-coding',
        })
      )
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(currentState?.activePlan?.id).toBe('kimi-code-membership');
    expect(loadSetupForm).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'kimi-for-coding' })
    );
  });

  it('advances a wizard from a connected verified plan to the next selected plan', async () => {
    await act(async () =>
      root.render(React.createElement(Harness, { mode: 'wizard', providerId: null }))
    );

    await act(async () => currentActions?.startWizard());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(currentState?.activePlan?.id).toBe('supergrok');
    expect(currentState?.stage).toBe('choose-model');
    expect(loadSetupForm).not.toHaveBeenCalledWith(expect.objectContaining({ providerId: 'xai' }));

    await act(async () => currentActions?.acceptVerifiedModel());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(currentState?.progress?.completedPlanIds).toContain('supergrok');
    expect(currentState?.activePlan?.id).toBe('zai-coding-plan');
    expect(loadSetupForm).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'zai-coding-plan' })
    );
  });

  it('resumes the current wizard plan without persisting a subscription secret', async () => {
    const stored = createRuntimeProviderOnboardingProgress(['supergrok', 'minimax-token-plan']);
    savedProgress = {
      ...stored,
      currentPlanId: 'minimax-token-plan',
      completedPlanIds: ['supergrok'],
      selectedModels: { supergrok: 'xai/grok-4.3' },
    };
    loadProviderDirectory.mockResolvedValueOnce(
      directoryResponse([
        directoryEntry('xai', 'connected', 'oauth'),
        directoryEntry('minimax-coding-plan', 'available'),
      ])
    );

    await act(async () =>
      root.render(React.createElement(Harness, { mode: 'wizard', providerId: null }))
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(loadSetupForm).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'minimax-coding-plan' })
    );
    expect(currentState?.wizardStarted).toBe(true);
    expect(currentState?.resumable).toBe(true);
    expect(currentState?.activePlan?.id).toBe('minimax-token-plan');
    expect(repository.save).toHaveBeenCalled();
    expect(JSON.stringify(savedProgress)).not.toContain('apiKey');
  });

  it('restores the completed Ready screen when the wizard was closed before Done', async () => {
    savedProgress = completeRuntimeProviderOnboardingPlan(
      createRuntimeProviderOnboardingProgress(['supergrok']),
      'supergrok',
      'xai/grok-4.3'
    );

    await act(async () =>
      root.render(React.createElement(Harness, { mode: 'wizard', providerId: null }))
    );

    expect(currentState?.wizardStarted).toBe(true);
    expect(currentState?.resumable).toBe(true);
    expect(currentState?.activePlan).toBeNull();
    expect(currentState?.stage).toBe('ready');
    expect(currentState?.progress?.completedPlanIds).toEqual(['supergrok']);
  });

  it('starts runtime installation after the user confirms a wizard with missing OpenCode', async () => {
    const onInstall = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        React.createElement(Harness, {
          mode: 'wizard',
          providerId: null,
          runtimeGate: 'missing',
          onInstall,
        })
      )
    );

    await act(async () => currentActions?.startWizard());

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(currentState?.wizardStarted).toBe(true);
    expect(repository.save).toHaveBeenCalled();
  });

  it('starts a runtime update before connecting plans that need a newer OpenCode bridge', async () => {
    const onInstall = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        React.createElement(Harness, {
          mode: 'wizard',
          providerId: null,
          runtimeUpdateRequired: true,
          onInstall,
        })
      )
    );

    await act(async () => currentActions?.startWizard());

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(currentState?.runtimeUpdateRequired).toBe(true);
    expect(currentState?.wizardStarted).toBe(true);
  });
});
