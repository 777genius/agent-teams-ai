import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock('@renderer/posthog', () => ({
  capturePostHogEvent: posthogMocks.capturePostHogEvent,
}));

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
} from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderOnboarding';
import {
  type RuntimeProviderOnboardingActions,
  type RuntimeProviderOnboardingState,
  useRuntimeProviderOnboarding,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderOnboarding';

import type {
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementDirectoryResponse,
} from '../../../../src/features/runtime-provider-management/contracts';
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
  let connectProvider: ReturnType<typeof vi.fn>;

  function Harness({
    mode = 'provider',
    providerId = 'xai',
    runtimeGate = 'ready',
    runtimeUpdateRequired = false,
    onInstall = vi.fn(),
  }: {
    mode?: 'provider' | 'wizard';
    providerId?: string | null;
    runtimeGate?: 'ready' | 'missing' | 'error';
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
    posthogMocks.capturePostHogEvent.mockClear();
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
    connectProvider = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadProviderDirectory,
          loadSetupForm,
          loadModels,
          testModel,
          loadView: vi.fn(),
          connectProvider,
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

  it('requires explicit confirmation before verifying an already connected plan', async () => {
    await act(async () => root.render(React.createElement(Harness)));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(currentState?.stage).toBe('connect');
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
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

  it('uses the current Copilot recommendation without probing the full provider catalog', async () => {
    loadProviderDirectory.mockResolvedValue(
      directoryResponse([directoryEntry('github-copilot', 'connected', 'oauth')])
    );
    loadModels.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      models: {
        runtimeId: 'opencode' as const,
        providerId: 'github-copilot',
        defaultModelId: null,
        diagnostics: [],
        models: [
          {
            modelId: 'github-copilot/gpt-4.1',
            providerId: 'github-copilot',
            displayName: 'GPT-4.1',
            sourceLabel: 'OpenCode',
            free: false,
            default: false,
            availability: 'untested' as const,
          },
          {
            modelId: 'github-copilot/gpt-5-mini',
            providerId: 'github-copilot',
            displayName: 'GPT-5 mini',
            sourceLabel: 'OpenCode',
            free: false,
            default: false,
            availability: 'untested' as const,
          },
          {
            modelId: 'github-copilot/claude-sonnet-4.6',
            providerId: 'github-copilot',
            displayName: 'Claude Sonnet 4.6',
            sourceLabel: 'OpenCode',
            free: false,
            default: false,
            availability: 'untested' as const,
          },
        ],
      },
    });
    testModel.mockImplementation(async (input: { providerId: string; modelId: string }) => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: input.providerId,
        modelId: input.modelId,
        ok: input.modelId === 'github-copilot/claude-sonnet-4.6',
        availability:
          input.modelId === 'github-copilot/claude-sonnet-4.6'
            ? ('available' as const)
            : ('unavailable' as const),
        message:
          input.modelId === 'github-copilot/claude-sonnet-4.6'
            ? 'Model probe passed'
            : 'The requested model is not supported',
        diagnostics: [],
      },
    }));

    await act(async () =>
      root.render(React.createElement(Harness, { providerId: 'github-copilot' }))
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    expect(testModel.mock.calls.map(([input]) => input.modelId)).toEqual([
      'github-copilot/gpt-5-mini',
      'github-copilot/claude-sonnet-4.6',
    ]);
    expect(currentState?.verifiedModelId).toBe('github-copilot/claude-sonnet-4.6');
    expect(currentState?.stage).toBe('choose-model');
  });

  it('keeps an explicit reconnect form open after a saved credential fails verification', async () => {
    testModel.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: 'xai',
        modelId: 'xai/grok-4.3',
        ok: false,
        availability: 'unavailable' as const,
        message: 'Refresh token has been revoked',
        diagnostics: [],
      },
    });

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(currentState?.stage).toBe('error');

    await act(async () => currentActions?.beginConnect());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    expect(currentState?.management.activeFormProviderId).toBe('xai');
    expect(currentState?.stage).toBe('connect');
    expect(testModel).toHaveBeenCalledTimes(1);
  });

  it('records an OAuth cancellation separately from an onboarding failure', async () => {
    loadProviderDirectory.mockResolvedValue(
      directoryResponse([directoryEntry('xai', 'available')])
    );
    loadSetupForm.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      setupForm: {
        runtimeId: 'opencode' as const,
        providerId: 'xai',
        displayName: 'SuperGrok',
        method: 'oauth' as const,
        supported: true,
        title: 'Connect SuperGrok',
        description: null,
        submitLabel: 'Continue in browser',
        disabledReason: null,
        source: 'oauth' as const,
        secret: null,
        prompts: [],
      },
    });
    connectProvider.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      error: {
        code: 'auth-failed' as const,
        message: 'Authorization cancelled',
        recoverable: true,
      },
    });

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => currentActions?.beginConnect());
    await act(async () => {
      await vi.waitFor(() => expect(loadSetupForm).toHaveBeenCalled());
    });

    let connected = true;
    await act(async () => {
      connected = (await currentActions?.submitConnect()) ?? false;
    });

    expect(connected).toBe(false);
    expect(currentState?.stage).toBe('connect');
    expect(currentState?.management.setupSubmitError).toBe(
      'SuperGrok connection was cancelled. Your current credential was not changed.'
    );
    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'provider_setup:onboarding_step_end',
      expect.objectContaining({
        event_schema_version: 2,
        provider: 'xai',
        step: 'connection_submit',
        outcome: 'cancelled',
        success: false,
        error_class: 'none',
      })
    );
    expect(posthogMocks.capturePostHogEvent).not.toHaveBeenCalledWith(
      'provider_setup:onboarding_step_end',
      expect.objectContaining({ outcome: 'failed' })
    );
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
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
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
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
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

  it('retries one transient runtime setup failure without leaving the user on an error screen', async () => {
    loadProviderDirectory.mockResolvedValueOnce(
      directoryResponse([directoryEntry('kimi-for-coding', 'available')])
    );
    loadSetupForm
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        error: {
          code: 'runtime-missing' as const,
          message: 'The runtime was still restarting after the OpenCode update.',
          recoverable: true,
          diagnostics: {
            errorCode: 'runtime-missing' as const,
            summary: 'Runtime restart in progress',
            likelyCause: null,
            binaryPath: null,
            command: null,
            projectPath: null,
            exitCode: null,
            stderrPreview: null,
            stdoutPreview: null,
            hints: [],
          },
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        setupForm: {
          runtimeId: 'opencode' as const,
          providerId: 'kimi-for-coding',
          displayName: 'Kimi Code Membership',
          method: 'api' as const,
          supported: true,
          title: 'Connect Kimi Code Membership',
          description: null,
          submitLabel: 'Connect',
          disabledReason: null,
          source: 'curated' as const,
          secret: {
            key: 'key' as const,
            label: 'Membership Key',
            placeholder: 'Paste key',
            required: true,
          },
          prompts: [],
        },
      });

    await act(async () =>
      root.render(React.createElement(Harness, { providerId: 'kimi-for-coding' }))
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(currentState?.management.setupFormErrorDiagnostics?.errorCode).toBe('runtime-missing');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    });

    expect(loadSetupForm).toHaveBeenCalledTimes(2);
    expect(currentState?.management.setupForm?.providerId).toBe('kimi-for-coding');
    expect(currentState?.management.setupFormError).toBeNull();
  });

  it('uses the connect execution proof without issuing a duplicate model request', async () => {
    const available = directoryEntry('minimax-coding-plan', 'available');
    let resolveRefresh: ((value: RuntimeProviderManagementDirectoryResponse) => void) | null = null;
    loadProviderDirectory
      .mockResolvedValueOnce(directoryResponse([available]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
    loadModels.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      models: {
        runtimeId: 'opencode' as const,
        providerId: 'minimax-coding-plan',
        defaultModelId: 'minimax-coding-plan/MiniMax-M2',
        diagnostics: [],
        models: [
          {
            modelId: 'minimax-coding-plan/MiniMax-M2',
            providerId: 'minimax-coding-plan',
            displayName: 'MiniMax M2',
            sourceLabel: 'OpenCode',
            free: false,
            default: true,
            availability: 'untested' as const,
          },
          {
            modelId: 'minimax-coding-plan/MiniMax-M3',
            providerId: 'minimax-coding-plan',
            displayName: 'MiniMax M3',
            sourceLabel: 'OpenCode',
            free: false,
            default: false,
            availability: 'untested' as const,
          },
        ],
      },
    });
    connectProvider.mockResolvedValue({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      provider: {
        providerId: 'minimax-coding-plan',
        displayName: 'MiniMax Token Plan',
        state: 'connected' as const,
        ownership: ['managed'] as const,
        recommended: true,
        modelCount: 1,
        defaultModelId: 'minimax-coding-plan/MiniMax-M2',
        authMethods: ['api'] as const,
        actions: [],
        detail: 'Connected and verified',
        connectedAuthHint: 'api' as const,
        verifiedModelId: 'minimax-coding-plan/MiniMax-M3',
      },
    });

    await act(async () =>
      root.render(React.createElement(Harness, { providerId: 'minimax-coding-plan' }))
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(currentState?.management.activeFormProviderId).toBe('minimax-coding-plan');

    await act(async () => currentActions?.management.setApiKeyValue('sk-cp-test'));
    let submitPromise: Promise<boolean> | undefined;
    await act(async () => {
      submitPromise = currentActions?.submitConnect();
      await vi.waitFor(() => expect(connectProvider).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });

    expect(currentState?.stage).toBe('verifying');
    expect(currentState?.verifiedModelId).toBeNull();
    expect(testModel).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-unhealthy',
          message: 'Provider refresh is temporarily unavailable',
          recoverable: true,
        },
      });
      await submitPromise;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(connectProvider).toHaveBeenCalledTimes(1);
    expect(testModel).not.toHaveBeenCalled();
    expect(currentState?.stage).toBe('choose-model');
    expect(currentState?.verifiedModelId).toBe('minimax-coding-plan/MiniMax-M3');
    expect(currentState?.management.directoryError).toBeNull();
    expect(currentState?.management.warningMessage).toContain(
      'The change is saved, but the latest provider status could not be refreshed.'
    );
  });

  it('surfaces provider directory failures instead of leaving setup loading forever', async () => {
    loadProviderDirectory.mockResolvedValueOnce({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      error: {
        code: 'runtime-unhealthy',
        message: 'OpenCode provider catalog is unavailable',
        recoverable: true,
      },
    });

    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(currentState?.stage).toBe('error');
    expect(currentState?.stageError).toBe('OpenCode provider catalog is unavailable');
    expect(currentState?.management.directoryLoading).toBe(false);
    expect(loadSetupForm).not.toHaveBeenCalled();

    loadProviderDirectory.mockResolvedValueOnce(
      directoryResponse([directoryEntry('xai', 'available')])
    );
    await act(async () => currentActions?.beginConnect());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
    expect(loadProviderDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: true })
    );
  });

  it('advances a wizard from a connected verified plan to the next selected plan', async () => {
    await act(async () =>
      root.render(React.createElement(Harness, { mode: 'wizard', providerId: null }))
    );

    await act(async () => currentActions?.startWizard());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(currentState?.stage).toBe('connect');
    expect(testModel).not.toHaveBeenCalled();
    await act(async () => currentActions?.beginVerification());
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

  it('records runtime preparation success only after the runtime gate reports ready', async () => {
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
    expect(
      posthogMocks.capturePostHogEvent.mock.calls.filter(
        ([eventName, properties]) =>
          eventName === 'provider_setup:onboarding_step_end' &&
          properties?.step === 'runtime_prepare'
      )
    ).toEqual([]);

    await act(async () =>
      root.render(
        React.createElement(Harness, {
          mode: 'wizard',
          providerId: null,
          runtimeGate: 'ready',
          onInstall,
        })
      )
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'provider_setup:onboarding_step_end',
      expect.objectContaining({
        provider: 'xai',
        step: 'runtime_prepare',
        success: true,
        error_class: 'none',
      })
    );
  });

  it('records runtime preparation failure when installation resolves but the runtime gate reports error', async () => {
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
    await act(async () =>
      root.render(
        React.createElement(Harness, {
          mode: 'wizard',
          providerId: null,
          runtimeGate: 'error',
          onInstall,
        })
      )
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });

    expect(posthogMocks.capturePostHogEvent).toHaveBeenCalledWith(
      'provider_setup:onboarding_step_end',
      expect.objectContaining({
        provider: 'xai',
        step: 'runtime_prepare',
        success: false,
        error_class: 'runtime_missing',
      })
    );
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
