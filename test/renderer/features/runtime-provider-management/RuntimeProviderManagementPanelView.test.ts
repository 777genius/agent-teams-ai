import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProviderManagementPanelView } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView';

import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';

function createState(
  overrides: Partial<RuntimeProviderManagementState> = {}
): RuntimeProviderManagementState {
  return {
    view: {
      runtimeId: 'opencode',
      title: 'OpenCode',
      runtime: {
        state: 'ready',
        cliPath: '/usr/local/bin/opencode',
        version: '1.14.24',
        managedProfile: 'active',
        localAuth: 'synced',
      },
      providers: [
        {
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          state: 'available',
          ownership: [],
          recommended: true,
          modelCount: 4,
          defaultModelId: null,
          authMethods: ['api'],
          actions: [
            {
              id: 'connect',
              label: 'Connect',
              enabled: true,
              disabledReason: null,
              requiresSecret: true,
              ownershipScope: 'managed',
            },
          ],
          detail: null,
        },
      ],
      defaultModel: null,
      fallbackModel: null,
      diagnostics: [],
    },
    providers: [],
    selectedProviderId: 'openrouter',
    providerQuery: '',
    directoryLoading: false,
    directoryRefreshing: false,
    directoryError: null,
    directoryErrorDiagnostics: null,
    directoryEntries: [],
    directoryTotalCount: null,
    directoryNextCursor: null,
    directoryLoaded: false,
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
    modelsLoadingMore: false,
    modelsTotalCount: null,
    modelsNextCursor: null,
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

function createActions(): RuntimeProviderManagementActions {
  return {
    refresh: vi.fn(() => Promise.resolve()),
    selectProvider: vi.fn(),
    setProviderQuery: vi.fn(),
    loadMoreDirectory: vi.fn(() => Promise.resolve()),
    refreshDirectory: vi.fn(() => Promise.resolve()),
    selectDirectoryProvider: vi.fn(),
    searchAllProviders: vi.fn(),
    startConnect: vi.fn(),
    startReconnect: vi.fn(),
    cancelConnect: vi.fn(),
    setApiKeyValue: vi.fn(),
    setAuthOption: vi.fn(),
    setSetupMetadataValue: vi.fn(),
    setOAuthCodeValue: vi.fn(),
    submitOAuthCode: vi.fn(() => Promise.resolve()),
    submitConnect: vi.fn(() => Promise.resolve({ verifiedModelId: null })),
    forgetProvider: vi.fn(() => Promise.resolve()),
    openProviderCredentialPage: vi.fn(() => Promise.resolve()),
    openModelPicker: vi.fn(),
    closeModelPicker: vi.fn(),
    setModelQuery: vi.fn(),
    loadMoreModels: vi.fn(() => Promise.resolve()),
    selectModel: vi.fn(),
    useModelForNewTeams: vi.fn(),
    testModel: vi.fn((providerId: string, modelId: string) =>
      Promise.resolve({
        providerId,
        modelId,
        ok: true,
        availability: 'available' as const,
        message: 'Model probe passed',
        diagnostics: [],
      })
    ),
    setDefaultModel: vi.fn(() => Promise.resolve()),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('HTMLInputElement value setter not found');
  }

  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function selectOpenCodeTab(host: HTMLElement, label: 'Models' | 'Providers'): Promise<void> {
  const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent?.trim().startsWith(label)
  );
  if (!trigger) {
    throw new Error(`${label} tab trigger not found`);
  }

  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
}

describe('RuntimeProviderManagementPanelView', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders provider loading without a duplicate OpenCode runtime summary', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: null,
            providers: [],
            loading: true,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Checking runtime');
    expect(host.textContent).not.toContain('Loading managed OpenCode runtime');
    expect(host.textContent).toContain('Loading OpenCode providers');
    expect(
      host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
    ).toBeNull();

    await selectOpenCodeTab(host, 'Models');

    expect(host.textContent).toContain('Loading OpenCode model routes');
    expect(
      host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
    ).not.toBeNull();
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThanOrEqual(8);
    expect(host.textContent).toContain('Refresh');
    const refreshButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Refresh')
    );
    expect(refreshButton?.disabled).toBe(true);

    expect(host.textContent).not.toContain('No launchable OpenCode model routes were reported yet');
  });

  it('requests the full managed view only after the Models tab is opened', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: null,
            providers: [],
            directoryLoading: true,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(actions.refresh).not.toHaveBeenCalled();

    await selectOpenCodeTab(host, 'Models');

    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  it('renders runtime command errors with a readable headline and multiline details', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message = [
      'OpenCode provider settings could not read the runtime response.',
      'Expected a JSON object from the Agent Teams runtime provider command.',
      'Resolved runtime binary: /opt/homebrew/bin/opencode',
      'Command: /opt/homebrew/bin/opencode runtime providers view --runtime opencode --json --compact',
      'stdout preview:',
      'Commands:',
      '  opencode providers',
    ].join('\n');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({ error: message }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const alert = host.querySelector<HTMLElement>('[data-testid="runtime-provider-error"]');
    const details = alert?.querySelector('pre');

    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain(
      'OpenCode provider settings could not read the runtime response.'
    );
    expect(details?.textContent).toContain('Resolved runtime binary: /opt/homebrew/bin/opencode');
    expect(details?.textContent).toContain('  opencode providers');
    expect(details?.className).toContain('whitespace-pre-wrap');
    expect(details?.className).toContain('font-mono');
  });

  it('shows the Windows administrator hint only for OpenCode node_modules symlink EPERM errors', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const symlinkError = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({ error: symlinkError }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Windows: run Agent Teams AI as Administrator');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            error: 'EPERM: operation not permitted, mkdir C:\\Program Files\\locked-project',
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Windows: run Agent Teams AI as Administrator');
  });

  it('copies fallback error text when structured diagnostics are unavailable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            error: 'Runtime provider crashed\nstderr preview:\nmissing bun',
            errorDiagnostics: null,
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy diagnostics'))
        ?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(
      'OpenCode provider settings diagnostics\n\nMessage:\nRuntime provider crashed\nstderr preview:\nmissing bun'
    );
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('copies diagnostics with the selection fallback when clipboard API is unavailable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            error: 'Runtime provider crashed\nstderr preview:\nmissing bun',
            errorDiagnostics: null,
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy diagnostics'))
        ?.click();
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(host.textContent).toContain('Copied');
    expect(document.querySelector('textarea')).toBeNull();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('renders structured runtime diagnostics and copies the full redacted report', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            error: 'OpenCode provider settings could not read the runtime response.',
            errorDiagnostics: {
              errorCode: 'runtime-unhealthy',
              summary: 'OpenCode provider settings could not read the runtime response.',
              likelyCause:
                'The app is launching the OpenCode CLI itself instead of the Agent Teams runtime.',
              binaryPath: '/opt/homebrew/bin/opencode',
              command:
                '/opt/homebrew/bin/opencode runtime providers view --runtime opencode --json --compact',
              projectPath: '/Users/test/project',
              exitCode: 1,
              stderrPreview: 'Command failed before JSON',
              stdoutPreview: 'Commands:\n  opencode providers',
              hints: [
                'Check CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH and CLAUDE_CLI_PATH.',
                'Those environment variables must not point to opencode.',
              ],
            },
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Likely cause');
    expect(host.textContent).toContain('/opt/homebrew/bin/opencode');
    expect(host.textContent).toContain('Command failed before JSON');
    expect(
      host.querySelector('[data-testid="runtime-provider-error-stderr-preview"]')?.textContent
    ).toContain('stderr preview');
    expect(
      host.querySelector('[data-testid="runtime-provider-error-stdout-preview"]')?.textContent
    ).toContain('opencode providers');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy diagnostics'))
        ?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('OpenCode provider settings diagnostics');
    expect(writeText.mock.calls[0][0]).toContain('Error code: runtime-unhealthy');
    expect(writeText.mock.calls[0][0]).toContain(
      'Resolved runtime binary: /opt/homebrew/bin/opencode'
    );
    expect(writeText.mock.calls[0][0]).toContain('stderr preview:');
    expect(writeText.mock.calls[0][0]).toContain('stdout preview:');
    expect(host.textContent).toContain('Copied');
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('does not activate a provider row when copying model diagnostics', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const actions = createActions();
    const base = createState();
    const provider = {
      ...base.view!.providers[0],
      state: 'connected' as const,
      modelCount: 2,
      actions: [
        {
          id: 'test' as const,
          label: 'Test',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...base.view!,
              providers: [provider],
            },
            providers: [provider],
            selectedProviderId: provider.providerId,
            modelPickerProviderId: provider.providerId,
            modelPickerMode: 'use',
            modelsError: 'Model list failed',
            modelsErrorDiagnostics: {
              summary: 'Model list failed',
              likelyCause: 'The runtime returned a malformed models response.',
              binaryPath: '/repo/cli-dev',
              command: '/repo/cli-dev runtime providers models --runtime opencode',
              projectPath: '/Users/test/project',
              exitCode: 1,
              stderrPreview: 'bad models payload',
              stdoutPreview: null,
              hints: ['Retry after refreshing the runtime.'],
            },
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy diagnostics'))
        ?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(actions.selectProvider).not.toHaveBeenCalled();
    expect(actions.startConnect).not.toHaveBeenCalled();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('renders structured diagnostics in provider form and model picker errors', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const provider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      modelCount: 4,
      actions: [
        {
          id: 'test' as const,
          label: 'Test',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            providers: [provider],
            selectedProviderId: provider.providerId,
            activeFormProviderId: provider.providerId,
            modelPickerProviderId: provider.providerId,
            modelPickerMode: 'use',
            setupSubmitError: 'Provider connect failed before JSON.',
            setupSubmitErrorDiagnostics: {
              summary: 'Provider connect failed before JSON.',
              likelyCause: 'The runtime command printed CLI help instead of JSON.',
              binaryPath: '/opt/homebrew/bin/opencode',
              command: '/opt/homebrew/bin/opencode runtime providers connect',
              projectPath: null,
              exitCode: 1,
              stderrPreview: 'unknown command',
              stdoutPreview: 'Commands:\n  opencode providers',
              hints: ['Check the resolved runtime binary.'],
            },
            modelsError: 'Provider models failed before JSON.',
            modelsErrorDiagnostics: {
              summary: 'Provider models failed before JSON.',
              likelyCause: 'The runtime command printed CLI help instead of JSON.',
              binaryPath: '/opt/homebrew/bin/opencode',
              command: '/opt/homebrew/bin/opencode runtime providers models',
              projectPath: null,
              exitCode: 1,
              stderrPreview: 'unknown command',
              stdoutPreview: 'Commands:\n  opencode providers',
              hints: ['Check the resolved runtime binary.'],
            },
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(
      host.querySelector('[data-testid="runtime-provider-setup-submit-error"]')?.textContent
    ).toContain('Provider connect failed before JSON.');
    expect(
      host.querySelector('[data-testid="runtime-provider-setup-submit-error"]')?.textContent
    ).toContain('/opt/homebrew/bin/opencode');
    expect(
      host.querySelector('[data-testid="runtime-provider-models-error"]')?.textContent
    ).toContain('Provider models failed before JSON.');
    expect(
      host.querySelector('[data-testid="runtime-provider-models-error"]')?.textContent
    ).toContain('opencode providers');
  });

  it('renders provider directory errors with preserved multiline details', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const message = [
      'OpenCode provider settings could not read the runtime response.',
      'stderr preview:',
      'runtime crashed before JSON',
    ].join('\n');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryError: message,
            directoryLoaded: true,
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const alert = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-directory-error"]'
    );
    const details = alert?.querySelector('pre');

    expect(alert?.getAttribute('role')).toBe('alert');
    expect(details?.textContent).toContain('stderr preview:');
    expect(details?.textContent).toContain('runtime crashed before JSON');
    expect(details?.className).toContain('whitespace-pre-wrap');
  });

  it('keeps project context out of the runtime summary and labels it as validation context', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [
                {
                  providerId: 'llama.cpp',
                  modelId: 'llama.cpp/qwen-test:0.5b',
                  displayName: 'qwen-test:0.5b',
                  sourceLabel: 'llama.cpp',
                  free: false,
                  default: false,
                  availability: 'available',
                  accessKind: 'verified',
                  routeKind: 'configured_local',
                  proofState: 'verified',
                  requiresExecutionProof: false,
                  accessReason: null,
                },
              ],
            },
          }),
          actions: createActions(),
          disabled: false,
          projectPath: '/Users/belief/dev/projects/321',
        })
      );
      await Promise.resolve();
    });

    await selectOpenCodeTab(host, 'Models');

    expect(host.textContent).toContain('OpenCode defaults');
    expect(host.textContent).toContain('Validation context');
    expect(host.textContent).toContain('Tests use 321. Default applies unless');
    expect(host.textContent).not.toContain('Project context: 321');
    expect(host.textContent).not.toContain('Current context: 321');
    expect(host.textContent).not.toContain('Managing selected project profile');
    expect(host.textContent).not.toContain('/Users/belief/dev/projects/321');
  });

  it('renders configured OpenCode model routes with local proof actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'untested' as const,
      accessKind: 'configured_authless' as const,
      routeKind: 'configured_local' as const,
      proofState: 'needs_probe' as const,
      requiresExecutionProof: true,
      accessReason: 'Execution proof required',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [configuredModel],
            },
            selectedModelId: 'llama.cpp/qwen-test:0.5b',
          }),
          actions,
          disabled: false,
          projectPath: '/tmp/project',
        })
      );
      await Promise.resolve();
    });

    await selectOpenCodeTab(host, 'Models');

    const row = host.querySelector<HTMLElement>(
      '[data-testid="configured-opencode-model-row-llama.cpp/qwen-test:0.5b"]'
    );
    expect(host.textContent).toContain('OpenCode model routes');
    expect(host.textContent).toContain('Known routes from OpenCode config');
    expect(row?.textContent).toContain('local');
    expect(row?.textContent).toContain('known route');
    expect(row?.textContent).toContain('needs test');

    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Test'))?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Save for team picker'))?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Set all-projects default'))?.click();
      await Promise.resolve();
    });

    expect(actions.testModel).toHaveBeenCalledWith('llama.cpp', 'llama.cpp/qwen-test:0.5b');
    expect(actions.useModelForNewTeams).toHaveBeenCalledWith('llama.cpp/qwen-test:0.5b');
    expect(actions.setDefaultModel).toHaveBeenCalledWith(
      'llama.cpp',
      'llama.cpp/qwen-test:0.5b',
      'all_projects'
    );
  });

  it('can set an all-projects OpenCode default from the model scope controls', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'available' as const,
      accessKind: 'verified' as const,
      routeKind: 'configured_local' as const,
      proofState: 'verified' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [configuredModel],
            },
          }),
          actions,
          disabled: false,
          projectPath: '/tmp/project-a',
        })
      );
      await Promise.resolve();
    });

    await selectOpenCodeTab(host, 'Models');

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Set all-projects default'))
        ?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Default for every project that does not have its own OpenCode override'
    );
    expect(host.textContent).toContain('Validation context');
    expect(actions.setDefaultModel).toHaveBeenCalledWith(
      'llama.cpp',
      'llama.cpp/qwen-test:0.5b',
      'all_projects'
    );
  });

  it('filters launchable OpenCode model routes by route text', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const localModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'available' as const,
      accessKind: 'verified' as const,
      routeKind: 'configured_local' as const,
      proofState: 'verified' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };
    const freeModel = {
      providerId: 'opencode',
      modelId: 'opencode/big-pickle',
      displayName: 'big-pickle',
      sourceLabel: 'OpenCode',
      free: true,
      default: false,
      availability: 'available' as const,
      accessKind: 'builtin_free' as const,
      routeKind: 'builtin_free' as const,
      proofState: 'not_required' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [localModel, freeModel],
            },
          }),
          actions: createActions(),
          disabled: false,
          projectPath: '/tmp/project-a',
        })
      );
      await Promise.resolve();
    });

    await selectOpenCodeTab(host, 'Models');

    const searchInput = host.querySelector<HTMLInputElement>(
      'input[placeholder="Search model routes"]'
    );
    expect(searchInput).not.toBeNull();
    expect(host.textContent).toContain('qwen-test:0.5b');
    expect(host.textContent).toContain('big-pickle');

    await act(async () => {
      setInputValue(searchInput!, 'pickle');
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('qwen-test:0.5b');
    expect(host.textContent).toContain('big-pickle');

    await act(async () => {
      setInputValue(searchInput!, 'missing-route');
      await Promise.resolve();
    });

    expect(host.textContent).toContain('No OpenCode model routes match');
    expect(host.textContent).toContain('missing-route');
  });

  it('opens providers first and keeps launchable routes in a separate tab', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const baseState = createState();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'untested' as const,
      accessKind: 'configured_authless' as const,
      routeKind: 'configured_local' as const,
      proofState: 'needs_probe' as const,
      requiresExecutionProof: true,
      accessReason: 'Execution proof required',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...baseState.view!,
              configuredModels: [configuredModel],
            },
            providers: baseState.view?.providers ?? [],
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers');
    expect(host.querySelector('[data-testid="runtime-provider-row-openrouter"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="configured-opencode-model-row-llama.cpp/qwen-test:0.5b"]')
    ).toBeNull();

    await selectOpenCodeTab(host, 'Models');

    expect(host.textContent).toContain('OpenCode model routes');
    expect(host.textContent).toContain('llama.cpp/qwen-test:0.5b');
    expect(host.textContent).toContain(
      'Select a validation context above to enable Test and Set default'
    );
    expect(host.querySelector('[data-testid="runtime-provider-row-openrouter"]')).toBeNull();

    const row = host.querySelector<HTMLElement>(
      '[data-testid="configured-opencode-model-row-llama.cpp/qwen-test:0.5b"]'
    );
    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => [button.textContent?.trim(), button.disabled])).toEqual([
      ['Test', true],
      ['Save for team picker', false],
      ['Set all-projects default', true],
    ]);
    expect(
      Array.from(row?.querySelectorAll('[title]') ?? []).some(
        (element) =>
          element.getAttribute('title') ===
          'Select a project context before testing or saving OpenCode defaults.'
      )
    ).toBe(true);
  });

  it('shows unknown OpenCode defaults without enabling launch actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const unknownDefaultModel = {
      providerId: 'openrouter',
      modelId: 'openrouter/moonshotai/kimi-k2',
      displayName: 'moonshotai/kimi-k2',
      sourceLabel: 'OpenRouter',
      free: false,
      default: true,
      availability: 'untested' as const,
      accessKind: 'unknown_model' as const,
      routeKind: 'catalog_provider' as const,
      proofState: 'not_required' as const,
      requiresExecutionProof: false,
      accessReason: 'Model was not found in the live catalog',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [unknownDefaultModel],
            },
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await selectOpenCodeTab(host, 'Models');

    const row = host.querySelector<HTMLElement>(
      '[data-testid="configured-opencode-model-row-openrouter/moonshotai/kimi-k2"]'
    );
    expect(row?.textContent).toContain('unknown');
    expect(row?.textContent).toContain('default');

    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true]);
    expect(
      Array.from(row?.querySelectorAll('[title]') ?? []).some(
        (element) =>
          element.getAttribute('title') ===
          'This model is the current OpenCode default, but it is not available in the live catalog yet.'
      )
    ).toBe(true);
    await act(async () => {
      buttons.forEach((button) => button.click());
      await Promise.resolve();
    });
    expect(actions.testModel).not.toHaveBeenCalled();
    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
    expect(actions.setDefaultModel).not.toHaveBeenCalled();
  });

  it('does not repeat runtime diagnostics already shown by the outer OpenCode summary', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseState = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...baseState.view!,
              diagnostics: [
                'Unable to connect. Is the computer able to access the url?',
                'Unable to connect. Is the computer able to access the url?',
              ],
            },
            providers: baseState.view?.providers ?? [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain(
      'Unable to connect. Is the computer able to access the url?'
    );
  });

  it('renders duplicate structured diagnostic hints without React key warnings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            error: 'OpenCode provider settings are using the wrong runtime binary.',
            errorDiagnostics: {
              summary: 'OpenCode provider settings are using the wrong runtime binary.',
              likelyCause:
                'The app resolved the OpenCode CLI itself as the Agent Teams runtime binary.',
              binaryPath: '/opt/homebrew/bin/opencode',
              command:
                '/opt/homebrew/bin/opencode runtime providers view --runtime opencode --json --compact',
              projectPath: null,
              exitCode: null,
              stderrPreview: null,
              stdoutPreview: null,
              hints: [
                'Those environment variables must not point to opencode.',
                'Those environment variables must not point to opencode.',
              ],
            },
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const duplicateHints = host.textContent?.match(
      /Those environment variables must not point to opencode\./g
    );
    const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
      call.some(
        (argument) =>
          typeof argument === 'string' &&
          argument.includes('Encountered two children with the same key')
      )
    );
    consoleError.mockRestore();

    expect(duplicateHints).toHaveLength(2);
    expect(duplicateKeyWarnings).toHaveLength(0);
  });

  it('renders provider actions and opens API-key form state without exposing a raw secret', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: { ...state, providers: state.view?.providers ?? [] },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).toContain('4 models');
    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter-header"]')?.className
    ).toContain('hover:bg-sky-400');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter"]')?.className
    ).toContain('border-b');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter"]')?.className
    ).not.toContain('rounded-lg');

    await act(async () => {
      Array.from(host.querySelectorAll('span'))
        .find((element) => element.textContent === 'OpenRouter')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');
    expect(actions.selectProvider).not.toHaveBeenCalled();

    vi.mocked(actions.startConnect).mockClear();

    await act(async () => {
      const connect = Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Connect')
      );
      connect?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            apiKeyValue: 'sk-secret-value',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              method: 'api',
              supported: true,
              title: 'Connect OpenRouter',
              description: null,
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'curated',
              secret: {
                key: 'key',
                label: 'API key',
                placeholder: 'Paste API key',
                required: true,
              },
              prompts: [],
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.textContent).not.toContain('sk-secret-value');
  });

  it('allows supported OAuth setup forms that do not require a secret to submit', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              method: 'oauth',
              supported: true,
              title: 'Connect OpenRouter',
              description: null,
              submitLabel: 'Continue with OpenRouter',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const submitButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue in browser'
    );
    expect(submitButton?.disabled).toBe(false);
  });

  it('shows clear Xiaomi Token Plan key and region guidance', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();
    const provider = {
      ...state.view!.providers[0],
      providerId: 'xiaomi-token-plan-ams',
      displayName: 'Xiaomi MiMo Token Plan - Europe',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            view: { ...state.view!, providers: [provider] },
            providers: [provider],
            activeFormProviderId: provider.providerId,
            apiKeyValue: 'sk-regular-payg-key',
            setupForm: {
              runtimeId: 'opencode',
              providerId: provider.providerId,
              displayName: provider.displayName,
              method: 'api',
              supported: true,
              title: `Connect ${provider.displayName}`,
              description:
                'Copy the tp-... key from the Xiaomi Token Plan page. Use this provider only when that page shows https://token-plan-ams.xiaomimimo.com/v1 as the Base URL.',
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'curated',
              secret: {
                key: 'key',
                label: 'Token Plan API Key (tp-...)',
                placeholder: 'tp-xxxxx',
                required: true,
              },
              prompts: [],
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Open Dedicated API Key page');
    expect(host.textContent).toContain('Token Plan API Key (tp-...)');
    expect(host.textContent).toContain('token-plan-ams.xiaomimimo.com');
    expect(host.querySelector('input[placeholder="tp-xxxxx"]')).not.toBeNull();
    expect(host.textContent).toContain('This plan requires a key starting with tp-');
    const connectButton = Array.from(
      host.querySelector('form')?.querySelectorAll('button') ?? []
    ).find((button) => button.textContent?.trim() === 'Connect');
    expect(connectButton?.disabled).toBe(true);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            view: { ...state.view!, providers: [provider] },
            providers: [provider],
            activeFormProviderId: provider.providerId,
            apiKeyValue: 'tp-valid-token-plan-key',
            setupForm: {
              runtimeId: 'opencode',
              providerId: provider.providerId,
              displayName: provider.displayName,
              method: 'api',
              supported: true,
              title: `Connect ${provider.displayName}`,
              description: 'Use the Token Plan key.',
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'curated',
              secret: {
                key: 'key',
                label: 'Token Plan API Key (tp-...)',
                placeholder: 'tp-xxxxx',
                required: true,
              },
              prompts: [],
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Token Plan key format detected');
    const keyInput = host.querySelector<HTMLInputElement>('input[placeholder="tp-xxxxx"]');
    expect(keyInput?.type).toBe('password');
    expect(keyInput?.autocomplete).toBe('new-password');
    expect(keyInput?.getAttribute('spellcheck')).toBe('false');
    const showKeyButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Show key'
    );
    act(() => showKeyButton?.click());
    expect(keyInput?.type).toBe('text');
    expect(actions.startConnect).not.toHaveBeenCalled();

    await act(async () => {
      host
        .querySelector('form')
        ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(actions.submitConnect).toHaveBeenCalledWith(provider.providerId);
    expect(actions.submitConnect).toHaveBeenCalledTimes(1);
    expect(actions.startConnect).not.toHaveBeenCalled();
  });

  it('offers retry when provider setup form loading fails', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            setupFormError: 'Provider setup could not be loaded',
          },
          actions,
          disabled: false,
        })
      );
    });

    const retry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry setup'
    );
    act(() => retry?.click());
    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');
  });

  it('shows generic OAuth browser progress and keeps cancellation available', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            savingProviderId: 'openrouter',
            selectedAuthOptionId: 'oauth:0',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'xAI',
              method: 'oauth',
              supported: true,
              title: 'Connect xAI',
              description: 'Use a subscription or an API key.',
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
              defaultAuthOptionId: 'oauth:0',
              authOptions: [
                {
                  id: 'oauth:0',
                  method: 'oauth',
                  methodIndex: 0,
                  label: 'SuperGrok subscription',
                  supported: true,
                  disabledReason: null,
                  secret: null,
                  prompts: [],
                },
                {
                  id: 'api:1',
                  method: 'api',
                  methodIndex: 1,
                  label: 'xAI API key',
                  supported: true,
                  disabledReason: null,
                  secret: {
                    key: 'key',
                    label: 'API key',
                    placeholder: 'Paste API key',
                    required: true,
                  },
                  prompts: [],
                },
              ],
            },
            oauthProgress: {
              operationId: 'oauth-operation-123',
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'xAI',
              authOptionId: 'oauth:0',
              methodIndex: 0,
              phase: 'waiting-for-browser',
              completionMethod: 'auto',
              instructions: 'Approve access in the browser window. Enter code A7F0-835A.',
              message: 'Your browser was opened. Finish authorization there.',
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('SuperGrok subscription');
    expect(host.textContent).toContain('Your browser was opened. Finish authorization there.');
    expect(host.textContent).not.toContain('accounts.x.ai');
    const genericCode = host.querySelector('[data-testid="runtime-provider-oauth-device-code"]');
    expect(genericCode?.textContent).toContain('A7F0-835A');
    expect(genericCode?.querySelector('button')).not.toBeNull();
    const cancelButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    );
    expect(cancelButton?.disabled).toBe(false);
  });

  it('updates the submit action when the selected SuperGrok auth method changes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const state = createState();
    const xaiProvider = {
      ...state.view!.providers[0],
      providerId: 'xai',
      displayName: 'SuperGrok',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            view: { ...state.view!, providers: [xaiProvider] },
            providers: [xaiProvider],
            activeFormProviderId: 'xai',
            selectedAuthOptionId: 'api:2',
            apiKeyValue: 'secret',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'xai',
              displayName: 'xAI',
              method: 'oauth',
              supported: true,
              title: 'Connect xAI',
              description: 'Use a subscription or an API key.',
              submitLabel: 'Get browser code',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
              defaultAuthOptionId: 'oauth:1',
              authOptions: [
                {
                  id: 'oauth:1',
                  method: 'oauth',
                  methodIndex: 1,
                  label: 'SuperGrok browser code (recommended)',
                  supported: true,
                  disabledReason: null,
                  secret: null,
                  prompts: [],
                },
                {
                  id: 'api:2',
                  method: 'api',
                  methodIndex: 2,
                  label: 'Manually enter API Key',
                  supported: true,
                  disabledReason: null,
                  secret: {
                    key: 'key',
                    label: 'Manually enter API Key',
                    placeholder: 'Paste API key',
                    required: true,
                  },
                  prompts: [],
                },
              ],
            },
          },
          actions: createActions(),
          disabled: false,
        })
      );
    });

    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Connect')
    ).toBe(true);
    expect(host.textContent).not.toContain('Get browser code');
    expect(host.textContent).toContain(
      'This uses xAI API billing, not your SuperGrok subscription quota.'
    );
  });

  it('shows the SuperGrok device code as a prominent copyable value', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();
    const xaiProvider = {
      ...state.view!.providers[0],
      providerId: 'xai',
      displayName: 'SuperGrok',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            view: { ...state.view!, providers: [xaiProvider] },
            providers: [xaiProvider],
            activeFormProviderId: 'xai',
            savingProviderId: 'xai',
            selectedAuthOptionId: 'oauth:1',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'xai',
              displayName: 'SuperGrok',
              method: 'oauth',
              supported: true,
              title: 'Connect SuperGrok',
              description: 'Use the browser device code.',
              submitLabel: 'Get browser code',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
              defaultAuthOptionId: 'oauth:1',
              authOptions: [
                {
                  id: 'oauth:1',
                  method: 'oauth',
                  methodIndex: 1,
                  label: 'SuperGrok browser code (recommended)',
                  supported: true,
                  disabledReason: null,
                  secret: null,
                  prompts: [],
                },
              ],
            },
            oauthProgress: {
              operationId: 'oauth-operation-device',
              runtimeId: 'opencode',
              providerId: 'xai',
              displayName: 'SuperGrok',
              authOptionId: 'oauth:1',
              methodIndex: 1,
              phase: 'waiting-for-browser',
              completionMethod: 'auto',
              instructions: 'Open xAI and enter code C8ZB-RJ9G to finish sign-in.',
              message: 'Waiting for xAI authorization.',
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const code = host.querySelector('[data-testid="runtime-provider-oauth-device-code"]');
    expect(code?.textContent).toContain('Enter this code in xAI');
    expect(code?.textContent).toContain('C8ZB-RJ9G');
    expect(code?.textContent).toContain('Waiting for confirmation - this updates automatically');
    expect(code?.querySelector('.text-xl')).not.toBeNull();
    expect(code?.className).toContain('flex-col');
    expect(code?.querySelector('button')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            view: { ...state.view!, providers: [xaiProvider] },
            providers: [xaiProvider],
            activeFormProviderId: 'xai',
            savingProviderId: 'xai',
            selectedAuthOptionId: 'oauth:1',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'xai',
              displayName: 'SuperGrok',
              method: 'oauth',
              supported: true,
              title: 'Connect SuperGrok',
              description: 'Use the browser device code.',
              submitLabel: 'Get browser code',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
              defaultAuthOptionId: 'oauth:1',
              authOptions: [
                {
                  id: 'oauth:1',
                  method: 'oauth',
                  methodIndex: 1,
                  label: 'SuperGrok browser code (recommended)',
                  supported: true,
                  disabledReason: null,
                  secret: null,
                  prompts: [],
                },
              ],
            },
            oauthProgress: {
              operationId: 'oauth-operation-device',
              runtimeId: 'opencode',
              providerId: 'xai',
              displayName: 'SuperGrok',
              authOptionId: 'oauth:1',
              methodIndex: 1,
              phase: 'completing',
              completionMethod: 'auto',
              instructions: null,
              message: 'Authorization received. Verifying your plan...',
            },
          },
          actions,
          disabled: false,
        })
      );
    });

    expect(host.textContent).toContain('Authorization received. Verifying your plan...');
    expect(host.textContent).not.toContain('C8ZB-RJ9G');
    expect(host.querySelector('[data-testid="runtime-provider-oauth-device-code"]')).toBeNull();
  });

  it('renders multiple compact provider actions without hiding forget behind connect', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const provider = {
      ...createState().view!.providers[0],
      actions: [
        {
          id: 'connect' as const,
          label: 'Connect',
          enabled: true,
          disabledReason: null,
          requiresSecret: true,
          ownershipScope: 'managed' as const,
        },
        {
          id: 'forget' as const,
          label: 'Forget',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'managed' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [provider],
            },
            providers: [provider],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.includes('Connect'))).toBe(true);
    expect(buttons.some((button) => button.textContent?.includes('Remove managed credential'))).toBe(
      true
    );

    await act(async () => {
      buttons
        .find((button) => button.textContent?.includes('Remove managed credential'))
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).not.toHaveBeenCalled();

    await act(async () => {
      buttons
        .find((button) => button.textContent?.includes('Remove managed credential'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.forgetProvider).toHaveBeenCalledWith('openrouter');
    expect(actions.startConnect).not.toHaveBeenCalled();
  });

  it('reuses the setup form for safe credential replacement on connected providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const provider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed' as const],
      connectedAuthHint: 'api' as const,
      detail: 'Connected via app-managed OpenCode credential',
      actions: [
        {
          id: 'reconnect' as const,
          label: 'Replace credential',
          enabled: true,
          disabledReason: null,
          requiresSecret: true,
          ownershipScope: 'managed' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: { ...createState().view!, providers: [provider] },
            providers: [provider],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const replaceButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Replace credential')
    );
    expect(host.textContent).not.toContain('Connection');
    expect(host.textContent).not.toContain('API credential');
    expect(host.textContent).not.toContain('Connected via app-managed OpenCode credential');
    expect(host.textContent).toContain('Models');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter"]')?.className
    ).not.toContain('bg-sky-400');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter-header"]')?.className
    ).toContain('bg-sky-400');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter-content"]')?.className
    ).toContain('border-l-2');
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter-content"]')?.className
    ).toContain('bg-white');
    const modelToolbar = host.querySelector('[data-testid="runtime-provider-model-toolbar"]');
    const modelSearch = host.querySelector('[data-testid="runtime-provider-model-search"]');
    expect(modelToolbar?.textContent).toContain('Models');
    expect(modelToolbar?.contains(modelSearch)).toBe(true);
    await act(async () => {
      replaceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(actions.startReconnect).toHaveBeenCalledWith('openrouter');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: { ...createState().view!, providers: [provider] },
            providers: [provider],
            activeFormProviderId: 'openrouter',
            connectionIntent: 'reconnect',
            selectedAuthOptionId: 'api:0',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              method: 'api',
              supported: true,
              title: 'Connect OpenRouter',
              description: 'Credential is stored in the managed profile.',
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'opencode-auth',
              secret: {
                key: 'key',
                label: 'API key',
                placeholder: 'Paste API key',
                required: true,
              },
              prompts: [],
              authOptions: [
                {
                  id: 'api:0',
                  method: 'api',
                  methodIndex: 0,
                  label: 'API key',
                  supported: true,
                  disabledReason: null,
                  secret: {
                    key: 'key',
                    label: 'API key',
                    placeholder: 'Paste API key',
                    required: true,
                  },
                  prompts: [],
                },
              ],
              defaultAuthOptionId: 'api:0',
            },
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Replace OpenRouter credential');
    expect(host.textContent).toContain('current managed credential stays active');
    expect(host.textContent).toContain('Replace and verify');
    expect((host.querySelector('input[type="password"]') as HTMLInputElement | null)?.value).toBe(
      ''
    );
  });

  it('supports keyboard activation for compact provider rows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: { ...state, providers: state.view?.providers ?? [] },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector('[data-testid="runtime-provider-row-openrouter"]');
    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('tabindex')).toBe('0');

    await act(async () => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');
  });

  it('filters providers from the local provider search', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const openRouterProvider = createState().view!.providers[0];
    const openAiProvider = {
      ...openRouterProvider,
      providerId: 'openai',
      displayName: 'OpenAI',
      recommended: false,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [openRouterProvider, openAiProvider],
            },
            providers: [openRouterProvider, openAiProvider],
            providerQuery: 'router',
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).not.toContain('OpenAI');

    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();
  });

  it('does not open a model list for a render-only filtered fallback provider', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const openRouterProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      modelCount: 174,
      actions: [],
    };
    const openAiProvider = {
      ...openRouterProvider,
      providerId: 'openai',
      displayName: 'OpenAI',
      recommended: false,
      defaultModelId: 'openai/gpt-5.4-mini-fast',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [openRouterProvider, openAiProvider],
            },
            providers: [openRouterProvider, openAiProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            providerQuery: 'openai',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/openai/gpt-oss-20b:free',
                displayName: 'openai/gpt-oss-20b:free',
                sourceLabel: 'OpenRouter',
                free: true,
                default: false,
                availability: 'untested',
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenAI');
    expect(host.textContent).not.toContain('OpenRouter');
    expect(
      host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
    ).toBeNull();
  });

  it('opens the OpenCode provider directory and renders directory rows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 115,
            directoryEntries: [
              {
                providerId: 'deepseek',
                displayName: 'DeepSeek',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 62,
                defaultModelId: null,
                authMethods: [],
                actions: [
                  {
                    id: 'configure',
                    label: 'Configure manually',
                    enabled: false,
                    disabledReason: 'OpenCode did not advertise API-key auth',
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'Models are visible, but no connected credential was reported',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: false,
                },
              },
              {
                providerId: 'cloudflare-workers-ai',
                displayName: 'Cloudflare Workers AI',
                state: 'not-connected',
                setupKind: 'connect-api-key',
                ownership: [],
                recommended: false,
                modelCount: 8,
                defaultModelId: null,
                authMethods: ['api'],
                actions: [
                  {
                    id: 'connect',
                    label: 'Connect',
                    enabled: true,
                    disabledReason: null,
                    requiresSecret: true,
                    ownershipScope: 'managed',
                  },
                ],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'App-managed API-key setup is available for this provider',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: true,
                  configuredAuthless: false,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('115 OpenCode providers');
    expect(host.textContent).not.toContain('Connected and recommended providers are shown first.');
    expect(host.textContent).toContain('DeepSeek');
    expect(host.textContent).toContain('Cloudflare Workers AI');
    expect(host.textContent).toContain('62 models');
    expect(host.textContent).toContain('OpenCode catalog');
    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="runtime-provider-catalog-list"]')?.className
    ).toContain('border-y');
    expect(
      host.querySelector('[data-testid="runtime-provider-directory-row-deepseek"]')?.className
    ).toContain('border-b');
    expect(
      host.querySelector('[data-testid="runtime-provider-directory-row-deepseek"]')?.className
    ).not.toContain('rounded-lg');

    await act(async () => {
      host
        .querySelector('[data-testid="runtime-provider-directory-row-deepseek"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
    expect(actions.startConnect).not.toHaveBeenCalled();

    await act(async () => {
      host
        .querySelector('[data-testid="runtime-provider-directory-row-cloudflare-workers-ai"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('cloudflare-workers-ai');
    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
  });

  it('shows an explicit zero-provider catalog count', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 0,
            directoryEntries: [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('0 OpenCode providers');
    expect(host.textContent).not.toContain('OpenCode provider catalog.');
  });

  it('uses singular provider catalog copy for one provider', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('1 OpenCode provider');
    expect(host.textContent).not.toContain('1 OpenCode providers');
  });

  it('renders every advertised directory action instead of hiding configure behind connect', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'manual-connectable',
                displayName: 'Manual Connectable',
                state: 'not-connected',
                setupKind: 'connect-api-key',
                ownership: [],
                recommended: false,
                modelCount: 1,
                defaultModelId: null,
                authMethods: ['api'],
                actions: [
                  {
                    id: 'connect',
                    label: 'Connect',
                    enabled: true,
                    disabledReason: null,
                    requiresSecret: true,
                    ownershipScope: 'managed',
                  },
                  {
                    id: 'configure',
                    label: 'Configure manually',
                    enabled: false,
                    disabledReason: 'Manual fallback is also available',
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: null,
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: true,
                  supportedInlineAuth: true,
                  configuredAuthless: false,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector(
      '[data-testid="runtime-provider-directory-row-manual-connectable"]'
    );
    const actionLabels = Array.from(row?.querySelectorAll('button') ?? []).map((button) =>
      button.textContent?.trim()
    );

    expect(actionLabels).toContain('Connect');
    expect(actionLabels).toContain('Configure manually');
  });

  it('opens model list for configured authless local directory providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'llama.cpp',
                displayName: 'llama.cpp',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 1,
                defaultModelId: null,
                authMethods: [],
                actions: [
                  {
                    id: 'test',
                    label: 'Test',
                    enabled: true,
                    disabledReason: null,
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['config-provider'],
                sourceLabel: 'configured',
                providerSource: null,
                detail: 'Configured local OpenCode model route is available',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: true,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-directory-row-llama.cpp"]'
    );
    expect(row?.textContent).toContain('Configured local');

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.selectDirectoryProvider).toHaveBeenCalledWith('llama.cpp');
  });

  it('labels connected authless bridges as connected instead of configured local', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'cursor-acp',
                displayName: 'Cursor ACP',
                state: 'connected',
                setupKind: 'connected',
                ownership: ['managed'],
                recommended: false,
                modelCount: 1,
                defaultModelId: 'cursor-acp/auto',
                authMethods: [],
                actions: [],
                sources: ['config-provider'],
                sourceLabel: 'configured',
                providerSource: 'config',
                detail: 'Connected through the managed OpenCode bridge',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: true,
                },
              },
            ],
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector('[data-testid="runtime-provider-directory-row-cursor-acp"]');
    expect(row?.textContent).toContain('Connected');
    expect(row?.textContent).not.toContain('Configured local');
  });

  it('uses the unified provider search when compact search has no matches', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            providerQuery: 'deep',
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'deepseek',
                displayName: 'DeepSeek',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 62,
                defaultModelId: null,
                authMethods: [],
                actions: [],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'Models are visible, but no connected credential was reported',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: false,
                },
              },
            ],
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('DeepSeek');
    expect(host.textContent).not.toContain('Search all OpenCode providers');
  });

  it('renders connected provider model picker actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      state: 'connected' as const,
      ownership: ['managed'] as const,
      recommended: true,
      modelCount: 174,
      defaultModelId: null,
      authMethods: ['api'] as const,
      actions: [
        {
          id: 'use' as const,
          label: 'Use',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
        {
          id: 'set-default' as const,
          label: 'Set default',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
      detail: null,
    };
    const state = createState({
      view: {
        ...createState().view!,
        providers: [connectedProvider],
      },
      providers: [connectedProvider],
      modelPickerProviderId: 'openrouter',
      modelPickerMode: 'use',
      models: [
        {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-20b:free',
          displayName: 'openai/gpt-oss-20b:free',
          sourceLabel: 'OpenRouter',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'opencode/big-pickle',
          displayName: 'opencode/big-pickle',
          sourceLabel: 'OpenCode',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/qwen/qwen3-coder-plus',
          displayName: 'qwen/qwen3-coder-plus',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-120b:free',
          displayName: 'openai/gpt-oss-120b:free',
          sourceLabel: 'OpenRouter',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'opencode/minimax-m2.5-free',
          displayName: 'minimax-m2.5-free',
          sourceLabel: 'OpenCode',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/mistralai/codestral-2508',
          displayName: 'mistralai/codestral-2508',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/anthropic/claude-sonnet-4.6',
          displayName: 'anthropic/claude-sonnet-4.6',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
      ],
      selectedModelId: 'openrouter/openai/gpt-oss-20b:free',
      modelResults: {
        'openrouter/openai/gpt-oss-20b:free': {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-20b:free',
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        },
      },
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state,
          actions,
          disabled: false,
          projectPath: '/tmp/project',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('openrouter/openai/gpt-oss-20b:free');
    expect(host.textContent).toContain('Saved for team picker');
    expect(host.textContent).toContain('Model probe passed');
    expect(host.textContent).toContain('Recommended');
    expect(host.textContent).toContain('Not recommended');
    expect(host.textContent).toContain('Not verified in OpenCode');
    expect(host.textContent).toContain('Tested');
    expect(host.textContent).toContain('Tested with limits');
    expect(host.textContent).toContain('Recommended only');
    expect(host.textContent).not.toContain('Set OpenCode default');
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Save for team picker'
      )
    ).toBe(false);
    expect(
      host.querySelector('[data-testid="runtime-provider-logo-openrouter"] svg')
    ).not.toBeNull();
    const connectedBadge = Array.from(host.querySelectorAll('span')).find(
      (span) => span.textContent === 'Connected'
    );
    expect(connectedBadge).toBeInstanceOf(HTMLSpanElement);
    expect(connectedBadge?.style.color).toBeTruthy();
    const modelSearch = host.querySelector<HTMLInputElement>(
      '[data-testid="runtime-provider-model-search"]'
    );
    const modelList = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-list"]'
    );
    expect(modelSearch?.style.paddingLeft).toBe('42px');
    expect(modelList?.style.maxHeight).toBe('300px');
    expect(host.querySelector('[data-testid="runtime-provider-model-virtual-list"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid^="runtime-provider-model-row-"]')).toHaveLength(7);
    expect(host.textContent).not.toContain('OpenRouterfree');
    const firstTestButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test'
    );
    expect(firstTestButton?.className).toContain('border');
    const modelResult = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-result-openrouter/openai/gpt-oss-20b:free"]'
    );
    expect(modelResult).toBeInstanceOf(HTMLElement);
    expect(modelResult?.style.color).toBe('#86efac');
    expect((host.textContent ?? '').indexOf('mistralai/codestral-2508')).toBeLessThan(
      (host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')
    );
    expect((host.textContent ?? '').indexOf('opencode/big-pickle')).toBeLessThan(
      (host.textContent ?? '').indexOf('minimax-m2.5-free')
    );
    expect((host.textContent ?? '').indexOf('mistralai/codestral-2508')).toBeLessThan(
      (host.textContent ?? '').indexOf('minimax-m2.5-free')
    );
    expect((host.textContent ?? '').indexOf('minimax-m2.5-free')).toBeLessThan(
      (host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')
    );
    expect((host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')).toBeLessThan(
      (host.textContent ?? '').indexOf('openrouter/openai/gpt-oss-20b:free')
    );
    await act(async () => {
      host
        .querySelector(
          '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).toHaveBeenCalledWith('openrouter/openai/gpt-oss-20b:free');
    expect(actions.selectProvider).not.toHaveBeenCalled();

    vi.mocked(actions.useModelForNewTeams).mockClear();
    await act(async () => {
      const notRecommendedRow = host.querySelector(
        '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
      );
      const notRecommendedTestButton = Array.from(
        notRecommendedRow?.querySelectorAll('button') ?? []
      ).find((button) => button.textContent?.trim() === 'Test');
      notRecommendedTestButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();

    await act(async () => {
      const notRecommendedRow = host.querySelector(
        '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
      );
      const notRecommendedTestButton = Array.from(
        notRecommendedRow?.querySelectorAll('button') ?? []
      ).find((button) => button.textContent?.trim() === 'Test');
      notRecommendedTestButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.testModel).toHaveBeenCalledWith(
      'openrouter',
      'openrouter/openai/gpt-oss-20b:free'
    );
    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
  });

  it('virtualizes large provider model lists while keeping the full scroll range', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 80,
      actions: [],
    };
    const models = Array.from({ length: 80 }, (_, index) => ({
      providerId: 'openrouter',
      modelId: `openrouter/test/model-${index}`,
      displayName: `test/model-${index}`,
      sourceLabel: 'OpenRouter',
      free: false,
      default: false,
      availability: 'untested' as const,
    }));
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function getOffsetHeight(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'runtime-provider-model-list' ? 300 : 112;
      });
    const offsetWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(900);

    try {
      await act(async () => {
        root.render(
          React.createElement(RuntimeProviderManagementPanelView, {
            state: createState({
              view: {
                ...createState().view!,
                providers: [connectedProvider],
              },
              providers: [connectedProvider],
              selectedProviderId: 'openrouter',
              modelPickerProviderId: 'openrouter',
              modelPickerMode: 'use',
              models,
            }),
            actions,
            disabled: false,
          })
        );
        await Promise.resolve();
      });

      const virtualList = host.querySelector<HTMLElement>(
        '[data-testid="runtime-provider-model-virtual-list"]'
      );
      const renderedRows = host.querySelectorAll(
        '[data-testid^="runtime-provider-model-row-"]'
      );

      expect(virtualList).not.toBeNull();
      expect(Number.parseFloat(virtualList?.style.height ?? '0')).toBeGreaterThan(300);
      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(models.length);
    } finally {
      offsetHeightSpy.mockRestore();
      offsetWidthSpy.mockRestore();
    }
  });

  it('loads the next model page once when the current page does not fill the viewport', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let finishLoadMore: (() => void) | undefined;
    const actions = createActions();
    actions.loadMoreModels = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoadMore = resolve;
        })
    );
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 2,
      actions: [],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/test/model-1',
                displayName: 'test/model-1',
                sourceLabel: 'OpenRouter',
                free: false,
                default: false,
                availability: 'untested',
              },
            ],
            modelsTotalCount: 2,
            modelsNextCursor: '1',
          }),
          actions,
          disabled: false,
        })
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(actions.loadMoreModels).toHaveBeenCalledTimes(1);
    const modelList = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-list"]'
    );
    await act(async () => {
      modelList?.dispatchEvent(new Event('scroll', { bubbles: true }));
      modelList?.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
    });
    expect(actions.loadMoreModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishLoadMore?.();
      await Promise.resolve();
    });
  });

  it('does not retry model pagination automatically while its error is visible', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 2,
      actions: [],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: { ...createState().view!, providers: [connectedProvider] },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            modelsError: 'Provider models load timed out',
            modelsTotalCount: 2,
            modelsNextCursor: '1',
          }),
          actions,
          disabled: false,
        })
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(actions.loadMoreModels).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Provider models load timed out');
  });

  it('preserves the model scroll position when a virtualized page is appended', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let finishLoadMore: (() => void) | undefined;
    const actions = createActions();
    actions.loadMoreModels = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoadMore = resolve;
        })
    );
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 100,
      actions: [],
    };
    const models = Array.from({ length: 80 }, (_, index) => ({
      providerId: 'openrouter',
      modelId: `openrouter/test/model-${index}`,
      displayName: `test/model-${index}`,
      sourceLabel: 'OpenRouter',
      free: false,
      default: false,
      availability: 'untested' as const,
    }));
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function getClientHeight(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'runtime-provider-model-list' ? 300 : 0;
      });
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function getScrollHeight(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'runtime-provider-model-list' ? 9_000 : 0;
      });

    try {
      await act(async () => {
        root.render(
          React.createElement(RuntimeProviderManagementPanelView, {
            state: createState({
              view: { ...createState().view!, providers: [connectedProvider] },
              providers: [connectedProvider],
              selectedProviderId: 'openrouter',
              modelPickerProviderId: 'openrouter',
              modelPickerMode: 'use',
              models,
              modelsTotalCount: 100,
              modelsNextCursor: '80',
            }),
            actions,
            disabled: false,
          })
        );
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      const modelList = host.querySelector<HTMLElement>(
        '[data-testid="runtime-provider-model-list"]'
      );
      expect(modelList).not.toBeNull();
      if (!modelList) {
        return;
      }
      modelList.scrollTop = 8_700;
      await act(async () => {
        modelList.dispatchEvent(new Event('scroll', { bubbles: true }));
        await Promise.resolve();
      });
      expect(actions.loadMoreModels).toHaveBeenCalledTimes(1);

      modelList.scrollTop = 0;
      await act(async () => {
        finishLoadMore?.();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
      expect(modelList.scrollTop).toBe(8_700);
    } finally {
      clientHeightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    }
  });

  it('filters provider model picker rows to free models', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 2,
      actions: [],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/anthropic/claude-haiku-4.5',
                displayName: 'anthropic/claude-haiku-4.5',
                sourceLabel: 'OpenRouter',
                free: true,
                default: false,
                availability: 'untested',
                routeKind: 'connected_provider',
              },
              {
                providerId: 'openrouter',
                modelId: 'openrouter/anthropic/claude-sonnet-4.6',
                displayName: 'anthropic/claude-sonnet-4.6',
                sourceLabel: 'OpenRouter',
                free: false,
                default: false,
                availability: 'untested',
                routeKind: 'connected_provider',
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Free only');
    expect(host.textContent).toContain('anthropic/claude-haiku-4.5');
    expect(host.textContent).toContain('anthropic/claude-sonnet-4.6');

    await act(async () => {
      host.querySelector<HTMLElement>('#runtime-provider-openrouter-free-only')?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('anthropic/claude-haiku-4.5');
    expect(host.textContent).not.toContain('anthropic/claude-sonnet-4.6');
  });

  it('keeps the model search input enabled while model results are loading', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 174,
      actions: [
        {
          id: 'use' as const,
          label: 'Use',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            modelQuery: 'claude',
            modelsLoading: true,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-testid="runtime-provider-model-search"]'
    );

    expect(searchInput).not.toBeNull();
    expect(searchInput?.disabled).toBe(false);
    expect(searchInput?.value).toBe('claude');
    expect(host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')).not.toBe(
      null
    );
  });

  it('does not expose disabled model rows as active buttons', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 1,
      actions: [],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/google/gemini-3-flash-preview',
                displayName: 'google/gemini-3-flash-preview',
                sourceLabel: 'OpenRouter',
                free: false,
                default: false,
                availability: 'untested',
              },
            ],
          }),
          actions,
          disabled: true,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-row-openrouter/google/gemini-3-flash-preview"]'
    );

    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.tabIndex).toBe(-1);

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
  });

  it('keeps directory provider models visible when a model row is selected', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const provider = {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      state: 'connected' as const,
      ownership: ['managed'] as const,
      recommended: true,
      modelCount: 174,
      defaultModelId: null,
      authMethods: ['api'] as const,
      actions: [],
      sources: ['opencode-provider'] as const,
      sourceLabel: 'OpenCode catalog',
      providerSource: 'models.dev',
      detail: 'Connected via app-managed OpenCode credential',
      setupKind: 'connected' as const,
      metadata: {
        hasKnownModels: true,
        requiresManualConfig: false,
        supportedInlineAuth: true,
        configuredAuthless: false,
      },
    };
    const state = createState({
      providers: [],
      directoryLoaded: true,
      directoryEntries: [provider],
      directoryTotalCount: 1,
      selectedProviderId: 'openrouter',
      modelPickerProviderId: 'openrouter',
      modelPickerMode: 'use',
      models: [
        {
          providerId: 'openrouter',
          modelId: 'openrouter/google/gemini-3-flash-preview',
          displayName: 'google/gemini-3-flash-preview',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
      ],
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state,
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      host
        .querySelector(
          '[data-testid="runtime-provider-model-row-openrouter/google/gemini-3-flash-preview"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).toHaveBeenCalledWith(
      'openrouter/google/gemini-3-flash-preview'
    );
    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
    expect(host.textContent).toContain('google/gemini-3-flash-preview');
    expect(host.textContent).not.toContain('No models found.');
  });

  it('renders verified brand icons for common OpenCode providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseProvider = createState().view!.providers[0];
    const providers = [
      { providerId: 'openrouter', displayName: 'OpenRouter' },
      { providerId: 'opencode', displayName: 'OpenCode Zen' },
      { providerId: 'openai', displayName: 'OpenAI' },
      { providerId: 'anthropic', displayName: 'Anthropic' },
      { providerId: 'google', displayName: 'Google' },
      { providerId: 'google-vertex', displayName: 'Vertex' },
      { providerId: 'vercel', displayName: 'Vercel AI Gateway' },
      { providerId: 'mistral', displayName: 'Mistral' },
      { providerId: 'github-models', displayName: 'GitHub Models' },
      { providerId: 'perplexity-agent', displayName: 'Perplexity Agent' },
      { providerId: 'nvidia', displayName: 'Nvidia' },
      { providerId: 'minimax', displayName: 'MiniMax' },
      { providerId: 'minimax-coding-plan', displayName: 'MiniMax Token Plan (minimax.io)' },
      { providerId: 'cloudflare-ai-gateway', displayName: 'Cloudflare AI Gateway' },
      { providerId: 'cloudflare-workers-ai', displayName: 'Cloudflare Workers AI' },
      { providerId: 'gitlab-duo', displayName: 'GitLab Duo' },
      { providerId: 'poe', displayName: 'Poe' },
      { providerId: 'cursor-acp', displayName: 'Cursor' },
    ].map((provider) => ({
      ...baseProvider,
      ...provider,
      state: 'not-connected' as const,
      recommended: false,
    }));

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers,
            },
            providers,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    for (const provider of providers) {
      const logo = host.querySelector(
        `[data-testid="runtime-provider-logo-${provider.providerId}"]`
      );
      expect(logo).not.toBeNull();
      expect(logo?.className).toContain('runtime-provider-brand-icon');
      expect(logo?.querySelector('svg,img')).not.toBeNull();
      expect(logo?.getAttribute('style')).toContain('--runtime-provider-brand-fallback-background');
      expect(logo?.getAttribute('style')).toContain('--runtime-provider-brand-fallback-border');
      if (logo?.querySelector('svg')) {
        expect(logo.getAttribute('style')).toContain('--runtime-provider-brand-fallback-color');
      }
    }
  });

  it('uses Models.dev logos only for verified providers and initials for unknown providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseProvider = createState().view!.providers[0];
    const providers = [
      { providerId: 'xai', displayName: 'xAI', logo: 'xai' },
      { providerId: 'groq', displayName: 'Groq', logo: 'groq' },
      { providerId: 'deepseek', displayName: 'DeepSeek', logo: 'deepseek' },
      { providerId: 'cohere', displayName: 'Cohere', logo: 'cohere' },
      {
        providerId: 'cloudferro-sherlock',
        displayName: 'CloudFerro Sherlock',
        logo: 'cloudferro-sherlock',
      },
      { providerId: 'clarifai', displayName: 'Clarifai', label: 'CL' },
      { providerId: 'unknown-provider', displayName: 'Unknown Provider', label: 'UN' },
    ].map((provider) => ({
      ...baseProvider,
      ...provider,
      state: 'not-connected' as const,
      recommended: false,
    }));

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers,
            },
            providers,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    for (const provider of providers) {
      const logo = host.querySelector(
        `[data-testid="runtime-provider-logo-${provider.providerId}"]`
      );
      if ('logo' in provider) {
        const image = logo?.querySelector('img') as HTMLImageElement | null;
        expect(image?.src).toContain(`https://models.dev/logos/${provider.logo}.svg`);
        expect(logo?.className).toContain('runtime-provider-brand-icon');
      } else {
        expect(logo?.textContent).toBe(provider.label);
      }
    }
  });
});
