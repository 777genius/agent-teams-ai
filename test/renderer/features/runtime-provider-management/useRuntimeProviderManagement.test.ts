import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type RuntimeProviderManagementActions,
  type RuntimeProviderManagementState,
  useRuntimeProviderManagement,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';
import {
  getStoredCreateTeamModel,
  getStoredCreateTeamProvider,
} from '../../../../src/renderer/services/createTeamPreferences';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementViewDto,
  RuntimeProviderManagementViewResponse,
} from '../../../../src/features/runtime-provider-management/contracts';
import type { ElectronAPI } from '../../../../src/shared/types/api';

function installRuntimeProviderManagementApi(
  response: RuntimeProviderManagementModelTestResponse
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      runtimeProviderManagement: {
        testModel: vi.fn(() => Promise.resolve(response)),
      },
    } as unknown as ElectronAPI,
  });
}

function createRuntimeView(
  providers: readonly RuntimeProviderConnectionDto[] = []
): RuntimeProviderManagementViewDto {
  return {
    runtimeId: 'opencode',
    title: 'OpenCode',
    runtime: {
      state: 'ready',
      cliPath: '/opt/homebrew/bin/opencode',
      version: '1.0.0',
      managedProfile: 'active',
      localAuth: 'synced',
    },
    providers,
    defaultModel: null,
    fallbackModel: null,
    diagnostics: [],
  };
}

function createOpenAiLocalProvider(): RuntimeProviderConnectionDto {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    state: 'connected',
    ownership: ['local'],
    recommended: true,
    modelCount: 12,
    defaultModelId: null,
    authMethods: ['oauth'],
    actions: [],
    detail: 'Connected via local OpenCode credential',
  };
}

function createOpenAiLocalDirectoryEntry(): RuntimeProviderDirectoryEntryDto {
  return {
    ...createOpenAiLocalProvider(),
    setupKind: 'connected',
    sources: ['opencode-provider'],
    sourceLabel: 'OpenCode catalog',
    providerSource: 'models.dev',
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: false,
      configuredAuthless: false,
    },
  };
}

function createEmptyDirectoryResponse(
  query: string | null = null
): RuntimeProviderManagementDirectoryResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      totalCount: 0,
      returnedCount: 0,
      query,
      filter: 'all',
      limit: 50,
      cursor: null,
      nextCursor: null,
      entries: [],
      diagnostics: [],
      fetchedAt: new Date(0).toISOString(),
    },
  };
}

describe('useRuntimeProviderManagement', () => {
  let host: HTMLDivElement;
  let state: RuntimeProviderManagementState | null = null;
  let actions: RuntimeProviderManagementActions | null = null;

  function Harness(): React.ReactElement {
    const hook = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: false,
    });
    state = hook[0];
    actions = hook[1];
    return React.createElement('div');
  }

  function EnabledHarness(props: { projectPath?: string | null }): React.ReactElement {
    const hook = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: true,
      projectPath: props.projectPath,
    });
    state = hook[0];
    actions = hook[1];
    return React.createElement('div');
  }

  function ConfigurableHarness(props: {
    enabled: boolean;
    directoryPageSize?: number;
    directorySummaryOnEnable?: boolean;
    projectPath?: string | null;
    loadViewOnEnable?: boolean;
    searchDirectoryOnQueryChange?: boolean;
    initialProviderId?: string | null;
    initialProviderAction?: 'connect' | 'reconnect' | 'select' | null;
    onProviderChanged?: () => Promise<void> | void;
  }): React.ReactElement {
    const hook = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: props.enabled,
      directoryPageSize: props.directoryPageSize,
      directorySummaryOnEnable: props.directorySummaryOnEnable,
      projectPath: props.projectPath,
      loadViewOnEnable: props.loadViewOnEnable,
      searchDirectoryOnQueryChange: props.searchDirectoryOnQueryChange,
      initialProviderId: props.initialProviderId,
      initialProviderAction: props.initialProviderAction,
      onProviderChanged: props.onProviderChanged,
    });
    state = hook[0];
    actions = hook[1];
    return React.createElement('div');
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    window.localStorage.clear();
    state = null;
    actions = null;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses a clicked model as the app default for new teams without a global success banner', async () => {
    const modelId = 'openrouter/openai/gpt-oss-20b:free';
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.useModelForNewTeams(modelId);
    });

    expect(state?.selectedModelId).toBe(modelId);
    expect(state?.successMessage).toBeNull();
    expect(getStoredCreateTeamProvider()).toBe('opencode');
    expect(getStoredCreateTeamModel('opencode')).toBe(modelId);
  });

  it('passes projectPath to the runtime provider management API', async () => {
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView(),
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    expect(loadView).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('defers the full managed view until explicitly requested', async () => {
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        view: createRuntimeView(),
      })
    );
    const loadProviderDirectory = vi.fn(() => Promise.resolve(createEmptyDirectoryResponse()));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ConfigurableHarness, {
          enabled: true,
          directoryPageSize: 100,
          loadViewOnEnable: false,
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledTimes(1));
    });

    expect(loadView).not.toHaveBeenCalled();
    expect(loadProviderDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));

    await act(async () => {
      await actions?.refreshDirectory();
    });

    expect(loadView).not.toHaveBeenCalled();
    expect(loadProviderDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: true })
    );

    await act(async () => {
      await actions?.refresh();
    });

    expect(loadView).toHaveBeenCalledTimes(1);
    expect(state?.view?.runtime.version).toBe('1.0.0');
  });

  it('opens a deep-linked provider setup after the directory row is ready', async () => {
    let resolveDirectory: ((response: RuntimeProviderManagementDirectoryResponse) => void) | null =
      null;
    const loadProviderDirectory = vi.fn(
      () =>
        new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
          resolveDirectory = resolve;
        })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        setupForm: {
          runtimeId: 'opencode' as const,
          providerId: 'xai',
          displayName: 'xAI',
          method: 'oauth' as const,
          supported: true,
          title: 'Connect xAI',
          description: 'Sign in with SuperGrok',
          submitLabel: 'Continue in browser',
          disabledReason: null,
          source: 'oauth' as const,
          secret: null,
          prompts: [],
          authOptions: [
            {
              id: 'oauth:0',
              method: 'oauth' as const,
              methodIndex: 0,
              label: 'xAI Grok OAuth (SuperGrok Subscription)',
              supported: true,
              disabledReason: null,
              secret: null,
              prompts: [],
            },
          ],
          defaultAuthOptionId: 'oauth:0',
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: { loadProviderDirectory, loadSetupForm },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ConfigurableHarness, {
          enabled: true,
          loadViewOnEnable: false,
          directorySummaryOnEnable: true,
          searchDirectoryOnQueryChange: false,
          initialProviderId: 'xai',
          initialProviderAction: 'connect',
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledTimes(1));
    });
    expect(loadProviderDirectory).toHaveBeenCalledWith(expect.objectContaining({ summary: true }));
    expect(loadSetupForm).not.toHaveBeenCalled();

    await act(async () => {
      resolveDirectory?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          entries: [
            {
              providerId: 'xai',
              displayName: 'xAI',
              state: 'available',
              connectedAuthHint: null,
              setupKind: 'connect-oauth',
              ownership: [],
              recommended: false,
              modelCount: 9,
              authMethods: ['oauth'],
              defaultModelId: null,
              sources: ['opencode-provider'],
              sourceLabel: 'OpenCode catalog',
              providerSource: 'custom',
              detail: 'App-managed OAuth setup is available for this provider',
              actions: [],
              metadata: {
                hasKnownModels: true,
                requiresManualConfig: false,
                supportedInlineAuth: true,
                configuredAuthless: false,
              },
            },
          ],
          diagnostics: [],
          fetchedAt: '2026-07-10T00:00:00.000Z',
        },
      });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadSetupForm).toHaveBeenCalledTimes(1));
    });

    expect(loadSetupForm).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'xai',
      projectPath: null,
    });
    expect(state?.activeFormProviderId).toBe('xai');
    expect(state?.setupForm?.defaultAuthOptionId).toBe('oauth:0');
    await act(async () => root.unmount());
  });

  it('reuses setup while preserving the connected auth method for reconnect', async () => {
    const mixedProvider: RuntimeProviderConnectionDto = {
      providerId: 'mixed-provider',
      displayName: 'Mixed Provider',
      state: 'connected',
      connectedAuthHint: 'api',
      ownership: ['managed'],
      recommended: false,
      modelCount: 2,
      authMethods: ['oauth', 'api'],
      defaultModelId: 'mixed-provider/default',
      detail: 'Connected via app-managed OpenCode credential',
      actions: [],
    };
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        view: createRuntimeView([mixedProvider]),
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        directory: {
          runtimeId: 'opencode' as const,
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all' as const,
          limit: 50,
          cursor: null,
          nextCursor: null,
          entries: [
            {
              providerId: 'mixed-provider',
              displayName: 'Mixed Provider',
              state: 'connected' as const,
              connectedAuthHint: 'api',
              setupKind: 'connected' as const,
              ownership: ['managed' as const],
              recommended: false,
              modelCount: 2,
              authMethods: ['oauth' as const, 'api' as const],
              defaultModelId: 'mixed-provider/default',
              sources: ['opencode-provider' as const],
              sourceLabel: 'OpenCode catalog',
              providerSource: 'custom',
              detail: 'Connected via app-managed OpenCode credential',
              actions: [],
              metadata: {
                hasKnownModels: true,
                requiresManualConfig: false,
                supportedInlineAuth: true,
                configuredAuthless: false,
              },
            },
          ],
          diagnostics: [],
          fetchedAt: '2026-07-13T00:00:00.000Z',
        },
      })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        setupForm: {
          runtimeId: 'opencode' as const,
          providerId: 'mixed-provider',
          displayName: 'Mixed Provider',
          method: 'oauth' as const,
          supported: true,
          title: 'Connect Mixed Provider',
          description: null,
          submitLabel: 'Continue in browser',
          disabledReason: null,
          source: 'oauth' as const,
          secret: null,
          prompts: [],
          authOptions: [
            {
              id: 'oauth:0',
              method: 'oauth' as const,
              methodIndex: 0,
              label: 'Browser sign-in',
              supported: true,
              disabledReason: null,
              secret: null,
              prompts: [],
            },
            {
              id: 'api:1',
              method: 'api' as const,
              methodIndex: 1,
              label: 'API key',
              supported: true,
              disabledReason: null,
              secret: {
                key: 'key' as const,
                label: 'API key',
                placeholder: 'Paste API key',
                required: true,
              },
              prompts: [],
            },
          ],
          defaultAuthOptionId: 'oauth:0',
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadSetupForm,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1 as const,
              runtimeId: 'opencode' as const,
              models: {
                runtimeId: 'opencode' as const,
                providerId: 'mixed-provider',
                displayName: 'Mixed Provider',
                models: [],
                totalCount: 0,
                query: null,
                limit: 250,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, {}));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadView).toHaveBeenCalled());
      await vi.waitFor(() => expect(state?.view?.providers).toHaveLength(1));
    });
    await act(async () => {
      actions?.startReconnect('mixed-provider');
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(loadSetupForm).toHaveBeenCalled());

    expect(state?.connectionIntent).toBe('reconnect');
    expect(state?.selectedAuthOptionId).toBe('api:1');
    expect(state?.apiKeyValue).toBe('');
    await act(async () => root.unmount());
  });

  it('keeps provider search local until full-catalog search is explicitly requested', async () => {
    const loadProviderDirectory = vi.fn((input: { query?: string | null }) =>
      Promise.resolve(createEmptyDirectoryResponse(input.query ?? null))
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadProviderDirectory,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ConfigurableHarness, {
          enabled: true,
          loadViewOnEnable: false,
          searchDirectoryOnQueryChange: false,
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledTimes(1));
    });

    act(() => {
      actions?.setProviderQuery('minimax-coding-plan');
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });

    expect(loadProviderDirectory).toHaveBeenCalledTimes(1);

    act(() => {
      actions?.searchAllProviders('minimax-coding-plan');
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledTimes(2));
    });

    expect(loadProviderDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'minimax-coding-plan' })
    );
  });

  it('clears structured errors and stale provider state when disabled', async () => {
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-misconfigured',
          message: 'OpenCode provider settings are using the wrong runtime binary.',
          recoverable: true,
          diagnostics: {
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
            hints: ['Those environment variables must not point to opencode.'],
          },
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ConfigurableHarness, { enabled: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(state?.error ?? '').toContain('wrong runtime binary');
      });
    });

    expect(state?.errorDiagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode');

    await act(async () => {
      root.render(React.createElement(ConfigurableHarness, { enabled: false }));
      await Promise.resolve();
    });

    expect(state?.view).toBeNull();
    expect(state?.selectedProviderId).toBeNull();
    expect(state?.error).toBeNull();
    expect(state?.errorDiagnostics).toBeNull();
    expect(state?.loading).toBe(false);
  });

  it('ignores pending directory and setup-form responses after being disabled', async () => {
    let resolveDirectory: ((response: RuntimeProviderManagementDirectoryResponse) => void) | null =
      null;
    let resolveSetupForm: ((response: RuntimeProviderManagementSetupFormResponse) => void) | null =
      null;
    const directoryResponse = new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
      resolveDirectory = resolve;
    });
    const setupFormResponse = new Promise<RuntimeProviderManagementSetupFormResponse>((resolve) => {
      resolveSetupForm = resolve;
    });
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView(),
      })
    );
    const loadProviderDirectory = vi.fn(() => directoryResponse);
    const loadSetupForm = vi.fn(() => setupFormResponse);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ConfigurableHarness, { enabled: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalled();
      });
      actions?.startConnect('openrouter');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    await act(async () => {
      root.render(React.createElement(ConfigurableHarness, { enabled: false }));
      await Promise.resolve();
    });

    await act(async () => {
      resolveDirectory?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          entries: [createOpenAiLocalDirectoryEntry()],
          diagnostics: [],
          fetchedAt: '2026-05-22T00:00:00.000Z',
        },
      });
      resolveSetupForm?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
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
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state?.directoryEntries).toEqual([]);
    expect(state?.directoryLoaded).toBe(false);
    expect(state?.setupForm).toBeNull();
    expect(state?.activeFormProviderId).toBeNull();
    expect(state?.setupFormLoading).toBe(false);
  });

  it('ignores stale provider views after project context changes', async () => {
    let resolveProjectA:
      | ((response: {
          schemaVersion: 1;
          runtimeId: 'opencode';
          view: RuntimeProviderManagementViewDto;
        }) => void)
      | null = null;
    const projectAResponse = new Promise<{
      schemaVersion: 1;
      runtimeId: 'opencode';
      view: RuntimeProviderManagementViewDto;
    }>((resolve) => {
      resolveProjectA = resolve;
    });
    const loadView = vi.fn((input: { projectPath?: string | null }) => {
      if (input.projectPath === '/tmp/project-a') {
        return projectAResponse;
      }
      return Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: '/tmp/project-b',
          defaultModel: 'opencode/project-b',
        },
      });
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-b' }));
      await Promise.resolve();
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');

    await act(async () => {
      resolveProjectA?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: '/tmp/project-a',
          defaultModel: 'opencode/project-a',
        },
      });
      await Promise.resolve();
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');
    expect(state?.view?.defaultModel).toBe('opencode/project-b');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('restarts provider directory loading when project context changes while loading', async () => {
    let resolveProjectADirectory:
      | ((response: RuntimeProviderManagementDirectoryResponse) => void)
      | null = null;
    let resolveProjectBDirectory:
      | ((response: RuntimeProviderManagementDirectoryResponse) => void)
      | null = null;
    const projectBEntry: RuntimeProviderDirectoryEntryDto = {
      ...createOpenAiLocalDirectoryEntry(),
      providerId: 'project-b-provider',
      displayName: 'Project B Provider',
    };
    const loadView = vi.fn((input: { projectPath?: string | null }) =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: input.projectPath ?? null,
        },
      })
    );
    const loadProviderDirectory = vi.fn((input: { projectPath?: string | null }) => {
      if (input.projectPath === '/tmp/project-a') {
        return new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
          resolveProjectADirectory = resolve;
        });
      }
      return new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
        resolveProjectBDirectory = resolve;
      });
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalledWith({
          runtimeId: 'opencode',
          projectPath: '/tmp/project-a',
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          refresh: false,
        });
      });
    });

    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-b' }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalledWith({
          runtimeId: 'opencode',
          projectPath: '/tmp/project-b',
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          refresh: false,
        });
      });
    });

    await act(async () => {
      resolveProjectBDirectory?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-05-22T00:00:00.000Z',
          entries: [projectBEntry],
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(state?.directoryEntries.map((entry) => entry.providerId)).toEqual([
      'project-b-provider',
    ]);

    await act(async () => {
      resolveProjectADirectory?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-05-22T00:00:00.000Z',
          entries: [createOpenAiLocalDirectoryEntry()],
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(state?.directoryEntries.map((entry) => entry.providerId)).toEqual([
      'project-b-provider',
    ]);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('drops stale model probe results after project context changes', async () => {
    const modelId = 'llama.cpp/qwen-test:0.5b';
    let resolveProbe: ((value: RuntimeProviderManagementModelTestResponse) => void) | null = null;
    const loadView = vi.fn((input: { projectPath?: string | null }) =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: input.projectPath ?? null,
          defaultModel: input.projectPath === '/tmp/project-b' ? 'opencode/project-b' : null,
        },
      })
    );
    const testModel = vi.fn(
      () =>
        new Promise<RuntimeProviderManagementModelTestResponse>((resolve) => {
          resolveProbe = resolve;
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          testModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    let probe: ReturnType<RuntimeProviderManagementActions['testModel']> | null = null;
    await act(async () => {
      probe = actions?.testModel('llama.cpp', modelId) ?? null;
      await Promise.resolve();
    });

    expect(testModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId,
      projectPath: '/tmp/project-a',
    });
    expect(state?.testingModelIds).toEqual([modelId]);

    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-b' }));
      await Promise.resolve();
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');
    expect(state?.testingModelIds).toEqual([]);

    await act(async () => {
      resolveProbe?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'llama.cpp',
          modelId,
          ok: true,
          availability: 'available',
          message: 'Stale project A probe passed',
          diagnostics: [],
        },
      });
      await probe;
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');
    expect(state?.modelResults[modelId]).toBeUndefined();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('drops stale set-default responses after project context changes', async () => {
    const projectAModelId = 'llama.cpp/project-a:0.5b';
    let resolveSetDefault: ((value: RuntimeProviderManagementViewResponse) => void) | null = null;
    const loadView = vi.fn((input: { projectPath?: string | null }) =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: input.projectPath ?? null,
          defaultModel: input.projectPath === '/tmp/project-b' ? 'opencode/project-b' : null,
        },
      })
    );
    const setDefaultModel = vi.fn(
      () =>
        new Promise<RuntimeProviderManagementViewResponse>((resolve) => {
          resolveSetDefault = resolve;
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          setDefaultModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    let setDefault: Promise<void> | null = null;
    await act(async () => {
      setDefault = actions?.setDefaultModel('llama.cpp', projectAModelId, 'project') ?? null;
      await Promise.resolve();
    });

    expect(setDefaultModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: projectAModelId,
      probe: true,
      scope: 'project',
      projectPath: '/tmp/project-a',
    });
    expect(state?.savingDefaultModelId).toBe(projectAModelId);

    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-b' }));
      await Promise.resolve();
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');
    expect(state?.savingDefaultModelId).toBeNull();

    await act(async () => {
      resolveSetDefault?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: '/tmp/project-a',
          defaultModel: projectAModelId,
        },
      });
      await setDefault;
    });

    expect(state?.view?.projectPath).toBe('/tmp/project-b');
    expect(state?.view?.defaultModel).toBe('opencode/project-b');
    expect(state?.selectedModelId).toBeNull();
    expect(state?.successMessage).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears pending provider save state after project context changes', async () => {
    const connectedProvider: RuntimeProviderConnectionDto = {
      ...createOpenAiLocalProvider(),
      ownership: ['managed'],
      detail: 'Connected via managed OpenCode credential',
    };
    let resolveConnect: ((value: RuntimeProviderManagementProviderResponse) => void) | null = null;
    const loadView = vi.fn((input: { projectPath?: string | null }) =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          projectPath: input.projectPath ?? null,
          defaultModel: input.projectPath === '/tmp/project-b' ? 'opencode/project-b' : null,
        },
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [createOpenAiLocalDirectoryEntry()],
          diagnostics: [],
        },
      })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'api',
          supported: true,
          title: 'Connect OpenAI',
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
      })
    );
    const connectProvider = vi.fn(
      (_input: { oauthOperationId?: string }) =>
        new Promise<RuntimeProviderManagementProviderResponse>((resolve) => {
          resolveConnect = resolve;
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadSetupForm,
          connectProvider,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    await act(async () => {
      actions?.startConnect('openai');
      actions?.setApiKeyValue('sk-project-a');
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    let submitPromise: ReturnType<RuntimeProviderManagementActions['submitConnect']> | null = null;
    await act(async () => {
      submitPromise = actions?.submitConnect('openai') ?? null;
      await vi.waitFor(() => {
        expect(connectProvider).toHaveBeenCalledWith({
          runtimeId: 'opencode',
          providerId: 'openai',
          method: 'api',
          apiKey: 'sk-project-a',
          metadata: {},
          projectPath: '/tmp/project-a',
        });
      });
      await Promise.resolve();
    });

    expect(state?.savingProviderId).toBe('openai');

    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-b' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(loadView).toHaveBeenCalledWith({
        runtimeId: 'opencode',
        projectPath: '/tmp/project-b',
      });
    });

    expect(state?.savingProviderId).toBeNull();
    expect(state?.activeFormProviderId).toBeNull();

    await act(async () => {
      resolveConnect?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: connectedProvider,
      });
      await submitPromise;
    });

    expect(state?.view?.providers).toEqual([]);
    expect(state?.savingProviderId).toBeNull();
    expect(state?.setupSubmitError).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('refreshes view and catalog after forgetting managed auth while local auth remains', async () => {
    const localProvider = createOpenAiLocalProvider();
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView([localProvider]),
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [createOpenAiLocalDirectoryEntry()],
          diagnostics: [],
        },
      })
    );
    const forgetCredential = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: localProvider,
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          forgetCredential,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(loadView).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await actions?.forgetProvider('openai');
    });

    expect(forgetCredential).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openai',
      projectPath: '/tmp/project-a',
    });
    expect(loadView).toHaveBeenCalledTimes(2);
    const refreshDirectoryArgs = {
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: true,
    };
    expect(loadProviderDirectory).toHaveBeenCalledWith(refreshDirectoryArgs);
    expect(state?.successMessage).toBe(
      'Managed credential removed. Provider remains connected through local OpenCode credentials.'
    );

    await act(async () => {
      await actions?.refreshDirectory();
    });

    expect(loadView).toHaveBeenCalledTimes(3);
    expect(
      loadProviderDirectory.mock.calls.filter((call) => {
        const input = (call as unknown[])[0] as { refresh?: boolean } | undefined;
        return input?.refresh === true;
      })
    ).toHaveLength(2);
    expect(state?.successMessage).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps connect action busy until the post-connect refresh finishes', async () => {
    const disconnectedProvider: RuntimeProviderConnectionDto = {
      ...createOpenAiLocalProvider(),
      state: 'not-connected',
      ownership: [],
      modelCount: 0,
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
    };
    const connectedProvider = createOpenAiLocalProvider();
    const initialViewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([disconnectedProvider]),
    };
    const refreshedViewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([connectedProvider]),
    };
    const directoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: null,
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [createOpenAiLocalDirectoryEntry()],
        diagnostics: [],
      },
    };
    let resolveRefreshView: (() => void) | null = null;
    let resolveRefreshDirectory: (() => void) | null = null;
    const loadView = vi
      .fn()
      .mockResolvedValueOnce(initialViewResponse)
      .mockImplementation(
        () =>
          new Promise<typeof refreshedViewResponse>((resolve) => {
            resolveRefreshView = () => resolve(refreshedViewResponse);
          })
      );
    const loadProviderDirectory = vi
      .fn()
      .mockResolvedValueOnce(directoryResponse)
      .mockImplementation(
        () =>
          new Promise<typeof directoryResponse>((resolve) => {
            resolveRefreshDirectory = () => resolve(directoryResponse);
          })
      );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'api',
          supported: true,
          title: 'Connect OpenAI',
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
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: connectedProvider,
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadSetupForm,
          connectProvider,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      actions?.startConnect('openai');
      actions?.setApiKeyValue('sk-good-value');
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    let submitPromise: ReturnType<RuntimeProviderManagementActions['submitConnect']> | null = null;
    await act(async () => {
      submitPromise = actions?.submitConnect('openai') ?? null;
      await vi.waitFor(() => {
        expect(connectProvider).toHaveBeenCalled();
      });
      await Promise.resolve();
    });

    expect(state?.savingProviderId).toBe('openai');
    expect(state?.activeFormProviderId).toBeNull();

    await act(async () => {
      resolveRefreshView?.();
      resolveRefreshDirectory?.();
      await submitPromise;
    });

    expect(loadView).toHaveBeenCalledTimes(2);
    expect(
      loadProviderDirectory.mock.calls.filter((call) => {
        const input = (call as unknown[])[0] as { refresh?: boolean } | undefined;
        return input?.refresh === true;
      })
    ).toHaveLength(1);
    expect(state?.savingProviderId).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps provider data visible during catalog refresh', async () => {
    const localProvider = { ...createOpenAiLocalProvider(), modelCount: 0 };
    const localDirectoryEntry = { ...createOpenAiLocalDirectoryEntry(), modelCount: 0 };
    const viewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([localProvider]),
    };
    const directoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: null,
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [localDirectoryEntry],
        diagnostics: [],
      },
    };
    let resolveRefreshView: (() => void) | null = null;
    let resolveRefreshDirectory: (() => void) | null = null;
    const loadView = vi
      .fn()
      .mockResolvedValueOnce(viewResponse)
      .mockImplementation(
        () =>
          new Promise<typeof viewResponse>((resolve) => {
            resolveRefreshView = () => resolve(viewResponse);
          })
      );
    const loadProviderDirectory = vi
      .fn()
      .mockResolvedValueOnce(directoryResponse)
      .mockImplementation(
        () =>
          new Promise<typeof directoryResponse>((resolve) => {
            resolveRefreshDirectory = () => resolve(directoryResponse);
          })
      );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(state?.providers).toHaveLength(1);
        expect(state?.directoryEntries).toHaveLength(1);
      });
    });

    let refreshPromise: Promise<void> | null = null;
    await act(async () => {
      refreshPromise = actions?.refreshDirectory() ?? null;
      await Promise.resolve();
    });

    expect(state?.loading).toBe(false);
    expect(state?.directoryRefreshing).toBe(true);
    expect(state?.providers).toHaveLength(1);
    expect(state?.directoryEntries).toHaveLength(1);

    await act(async () => {
      resolveRefreshView?.();
      resolveRefreshDirectory?.();
      await refreshPromise;
    });

    expect(state?.loading).toBe(false);
    expect(state?.directoryRefreshing).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it('lazy-loads provider directory and ignores stale search responses', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          runtimeId: 'opencode',
          title: 'OpenCode',
          runtime: {
            state: 'ready',
            cliPath: '/opt/homebrew/bin/opencode',
            version: '1.0.0',
            managedProfile: 'active',
            localAuth: 'synced',
          },
          providers: [],
          defaultModel: null,
          fallbackModel: null,
          diagnostics: [],
        },
      })
    );
    const deepseekDirectoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: 'deep',
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [
          {
            providerId: 'deepseek',
            displayName: 'DeepSeek',
            state: 'available' as const,
            setupKind: 'available-readonly' as const,
            ownership: [],
            recommended: false,
            modelCount: 62,
            authMethods: [],
            defaultModelId: null,
            sources: ['opencode-provider'] as const,
            sourceLabel: 'OpenCode catalog',
            providerSource: 'models.dev',
            detail: null,
            actions: [],
            metadata: {
              hasKnownModels: true,
              requiresManualConfig: false,
              supportedInlineAuth: false,
              configuredAuthless: false,
            },
          },
        ],
        diagnostics: [],
      },
    };
    const loadProviderDirectory = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    loadProviderDirectory.mockResolvedValue(deepseekDirectoryResponse);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalled();
      });
    });
    const callCountBeforeSearch = loadProviderDirectory.mock.calls.length;

    act(() => {
      actions?.setProviderQuery('deep');
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await vi.waitFor(() => {
        expect(loadProviderDirectory.mock.calls.length).toBeGreaterThan(callCountBeforeSearch);
      });
    });

    await act(async () => {
      resolveFirst?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [
            {
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              state: 'connected',
              setupKind: 'connected',
              ownership: ['managed'],
              recommended: true,
              modelCount: 174,
              authMethods: ['api'],
              defaultModelId: null,
              sources: ['opencode-provider'],
              sourceLabel: 'OpenCode catalog',
              providerSource: 'models.dev',
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
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(loadProviderDirectory).toHaveBeenLastCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
      query: 'deep',
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: false,
    });
    expect(state?.directoryEntries.map((entry) => entry.providerId)).toEqual(['deepseek']);
  });

  it('keeps the API key draft when provider connect fails', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
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
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'auth-failed',
          message: 'Invalid API key',
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
          connectProvider,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.startConnect('openrouter');
      actions?.setApiKeyValue('sk-bad-value');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    await act(async () => {
      await actions?.submitConnect('openrouter');
    });

    expect(connectProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-bad-value',
      metadata: {},
      projectPath: null,
    });
    expect(state?.error).toBeNull();
    expect(state?.setupSubmitError).toBe('Invalid API key');
    expect(state?.apiKeyValue).toBe('sk-bad-value');
  });

  it('keeps setup form diagnostics available when submit is attempted after form load failure', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'runtime-misconfigured',
          message: 'OpenCode provider settings are using the wrong runtime binary.',
          recoverable: true,
          diagnostics: {
            summary: 'OpenCode provider settings are using the wrong runtime binary.',
            likelyCause: 'The app resolved the OpenCode CLI itself as the runtime binary.',
            binaryPath: '/opt/homebrew/bin/opencode',
            command: '/opt/homebrew/bin/opencode runtime providers setup-form',
            projectPath: null,
            exitCode: null,
            stderrPreview: null,
            stdoutPreview: null,
            hints: ['Those environment variables must not point to opencode.'],
          },
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.startConnect('openrouter');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    expect(state?.setupFormError).toBe(
      'OpenCode provider settings are using the wrong runtime binary.'
    );
    expect(state?.setupFormErrorDiagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode');

    await act(async () => {
      await actions?.submitConnect('openrouter');
    });

    expect(state?.setupSubmitError).toBe(
      'OpenCode provider settings are using the wrong runtime binary.'
    );
    expect(state?.setupSubmitErrorDiagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode');
  });

  it('submits a supported setup form without a secret as a null API key', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'oauth',
          supported: true,
          title: 'Connect OpenAI',
          description: null,
          submitLabel: 'Connect',
          disabledReason: null,
          source: 'oauth',
          secret: null,
          prompts: [],
        },
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: createOpenAiLocalProvider(),
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
          connectProvider,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.startConnect('openai');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    await act(async () => {
      await actions?.submitConnect('openai');
    });

    expect(connectProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openai',
      method: 'oauth',
      apiKey: null,
      metadata: {},
      oauthOperationId: expect.any(String),
      projectPath: null,
    });
    expect(state?.setupSubmitError).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps the actual API credential hint when xAI refresh fails after connect', async () => {
    const xaiEntry: RuntimeProviderDirectoryEntryDto = {
      providerId: 'xai',
      displayName: 'xAI',
      state: 'available',
      connectedAuthHint: null,
      setupKind: 'connect-api-key',
      ownership: [],
      recommended: true,
      modelCount: 4,
      authMethods: ['oauth', 'api'],
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
    };
    const initialDirectoryResponse: RuntimeProviderManagementDirectoryResponse = {
        ...createEmptyDirectoryResponse(),
        directory: {
          ...createEmptyDirectoryResponse().directory!,
          totalCount: 1,
          returnedCount: 1,
          entries: [xaiEntry],
        },
      };
    const loadProviderDirectory = vi.fn((input: { refresh?: boolean }) =>
      Promise.resolve(
        input.refresh
          ? {
              schemaVersion: 1 as const,
              runtimeId: 'opencode' as const,
              error: {
                code: 'runtime-unhealthy' as const,
                message: 'Catalog refresh failed',
                recoverable: true,
              },
            }
          : initialDirectoryResponse
      )
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        setupForm: {
          runtimeId: 'opencode' as const,
          providerId: 'xai',
          displayName: 'xAI',
          method: 'api' as const,
          supported: true,
          title: 'Connect xAI API key',
          description: null,
          submitLabel: 'Connect',
          disabledReason: null,
          source: 'curated' as const,
          secret: {
            key: 'key' as const,
            label: 'API key',
            placeholder: 'xai-...',
            required: true,
          },
          prompts: [],
        },
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        provider: {
          providerId: 'xai',
          displayName: 'xAI',
          state: 'connected' as const,
          ownership: ['managed'] as const,
          recommended: true,
          modelCount: 4,
          defaultModelId: 'xai/grok-4.3',
          authMethods: ['oauth', 'api'] as const,
          actions: [],
          detail: 'Connected with API key',
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadProviderDirectory,
          loadSetupForm,
          connectProvider,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'xai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ConfigurableHarness, {
          enabled: true,
          loadViewOnEnable: false,
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(state?.directoryLoaded).toBe(true);
    act(() => actions?.startConnect('xai'));
    await act(async () => {
      await vi.waitFor(() => expect(loadSetupForm).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state?.setupForm?.providerId).toBe('xai');
    act(() => actions?.setApiKeyValue('xai-test-key'));
    await act(async () => {
      await actions?.submitConnect('xai');
    });

    expect(state?.directoryEntries[0]?.state).toBe('connected');
    expect(state?.directoryEntries[0]?.connectedAuthHint).toBe('api');
    expect(state?.directoryError).toBe('Catalog refresh failed');

    await act(async () => root.unmount());
  });

  it('refreshes provider status after a cancelled OAuth child settles', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
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
          submitLabel: 'Get browser code',
          disabledReason: null,
          source: 'oauth' as const,
          secret: null,
          prompts: [],
        },
      })
    );
    let resolveConnect: ((value: RuntimeProviderManagementProviderResponse) => void) | null = null;
    let capturedOperationId: string | undefined;
    const connectProvider = vi.fn((input: { oauthOperationId?: string }) => {
      capturedOperationId = input.oauthOperationId;
      return new Promise<RuntimeProviderManagementProviderResponse>((resolve) => {
        resolveConnect = resolve;
      });
    });
    let resolveCancel: (() => void) | null = null;
    const cancelOAuth = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveCancel = () => resolve({ ok: true });
        })
    );
    const onProviderChanged = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
          connectProvider,
          cancelOAuth,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ConfigurableHarness, {
          enabled: false,
          onProviderChanged,
        })
      );
      await Promise.resolve();
    });
    act(() => actions?.startConnect('xai'));
    await act(async () => {
      await vi.waitFor(() => expect(loadSetupForm).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state?.setupForm?.providerId).toBe('xai');

    let submitPromise: ReturnType<RuntimeProviderManagementActions['submitConnect']> | null = null;
    await act(async () => {
      submitPromise = actions?.submitConnect('xai') ?? null;
      await vi.waitFor(() => expect(connectProvider).toHaveBeenCalled());
    });
    const operationId = capturedOperationId;

    await act(async () => {
      actions?.cancelConnect();
      await Promise.resolve();
    });
    expect(cancelOAuth).toHaveBeenCalledWith({ operationId });
    expect(onProviderChanged).not.toHaveBeenCalled();

    await act(async () => {
      resolveCancel?.();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(onProviderChanged).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveConnect?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: { code: 'auth-failed', message: 'Authorization cancelled', recoverable: true },
      });
      await submitPromise;
      root.unmount();
    });
  });

  it('clears model loading when switching from model picker to setup form', async () => {
    const localProvider = createOpenAiLocalProvider();
    let resolveModels: ((value: unknown) => void) | null = null;
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView([localProvider]),
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 0,
          returnedCount: 0,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [],
          diagnostics: [],
        },
      })
    );
    const loadModels = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
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
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadModels,
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadModels).toHaveBeenCalled();
        expect(state?.modelsLoading).toBe(true);
      });
    });

    await act(async () => {
      actions?.startConnect('openrouter');
      await Promise.resolve();
    });

    expect(state?.modelPickerProviderId).toBeNull();
    expect(state?.activeFormProviderId).toBe('openrouter');
    expect(state?.modelsLoading).toBe(false);

    await act(async () => {
      resolveModels?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        models: {
          runtimeId: 'opencode',
          providerId: 'openai',
          models: [
            {
              modelId: 'openai/stale-model',
              providerId: 'openai',
              displayName: 'Stale model',
              sourceLabel: 'OpenCode catalog',
              free: false,
              default: false,
              availability: 'available',
            },
          ],
          defaultModelId: null,
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(state?.modelsLoading).toBe(false);
    expect(state?.models).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });

  it('tracks concurrent model probes independently', async () => {
    const firstModelId = 'openrouter/anthropic/claude-3.5-haiku';
    const secondModelId = 'openrouter/openai/gpt-oss-20b:free';
    const resolvers = new Map<string, (value: unknown) => void>();
    const testModel = vi.fn(
      (input: { modelId: string }) =>
        new Promise((resolve) => {
          resolvers.set(input.modelId, resolve);
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          testModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    let firstProbe: ReturnType<RuntimeProviderManagementActions['testModel']> | null = null;
    let secondProbe: ReturnType<RuntimeProviderManagementActions['testModel']> | null = null;
    await act(async () => {
      firstProbe = actions?.testModel('openrouter', firstModelId) ?? null;
      secondProbe = actions?.testModel('openrouter', secondModelId) ?? null;
      await Promise.resolve();
    });

    expect(state?.testingModelIds).toEqual([firstModelId, secondModelId]);

    await act(async () => {
      resolvers.get(firstModelId)?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId: firstModelId,
          ok: true,
          availability: 'available',
          message: 'First passed',
          diagnostics: [],
        },
      });
      await firstProbe;
    });

    expect(state?.testingModelIds).toEqual([secondModelId]);

    await act(async () => {
      resolvers.get(secondModelId)?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId: secondModelId,
          ok: true,
          availability: 'available',
          message: 'Second passed',
          diagnostics: [],
        },
      });
      await secondProbe;
    });

    expect(state?.testingModelIds).toEqual([]);
    expect(state?.modelResults[firstModelId]?.message).toBe('First passed');
    expect(state?.modelResults[secondModelId]?.message).toBe('Second passed');

    await act(async () => {
      root.unmount();
    });
  });

  it('drops stale model probe results after leaving the model picker', async () => {
    const modelId = 'openrouter/anthropic/claude-3.5-haiku';
    let resolveProbe: ((value: RuntimeProviderManagementModelTestResponse) => void) | null = null;
    const testModel = vi.fn(
      () =>
        new Promise<RuntimeProviderManagementModelTestResponse>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'api',
          supported: true,
          title: 'Connect OpenAI',
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
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          testModel,
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.openModelPicker('openrouter', 'use');
    });

    let probe: ReturnType<RuntimeProviderManagementActions['testModel']> | null = null;
    await act(async () => {
      probe = actions?.testModel('openrouter', modelId) ?? null;
      await Promise.resolve();
    });

    expect(state?.testingModelIds).toEqual([modelId]);

    await act(async () => {
      actions?.startConnect('openai');
      await Promise.resolve();
    });

    expect(state?.modelPickerProviderId).toBeNull();
    expect(state?.testingModelIds).toEqual([]);

    await act(async () => {
      resolveProbe?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId,
          ok: true,
          availability: 'available',
          message: 'Stale probe passed',
          diagnostics: [],
        },
      });
      await probe;
    });

    expect(state?.modelResults[modelId]).toBeUndefined();
    expect(state?.testingModelIds).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps failed model probes scoped to the model result instead of a global success banner', async () => {
    const modelId = 'openrouter/anthropic/claude-3.5-haiku';
    const message =
      'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 381.';
    installRuntimeProviderManagementApi({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'openrouter',
        modelId,
        ok: false,
        availability: 'unavailable',
        message,
        diagnostics: [],
      },
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.testModel('openrouter', modelId);
    });

    expect(state?.successMessage).toBeNull();
    expect(state?.error).toBeNull();
    expect(state?.modelResults[modelId]?.ok).toBe(false);
    expect(state?.modelResults[modelId]?.message).toBe(message);
  });

  it('promotes structured model probe failures to the global diagnostics alert state', async () => {
    const modelId = 'openrouter/anthropic/claude-3.5-haiku';
    installRuntimeProviderManagementApi({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'runtime-misconfigured',
        message: 'OpenCode provider settings are using the wrong runtime binary.',
        recoverable: true,
        diagnostics: {
          summary: 'OpenCode provider settings are using the wrong runtime binary.',
          likelyCause: 'The app resolved the OpenCode CLI itself as the runtime binary.',
          binaryPath: '/opt/homebrew/bin/opencode',
          command: '/opt/homebrew/bin/opencode runtime providers test-model',
          projectPath: null,
          exitCode: null,
          stderrPreview: null,
          stdoutPreview: null,
          hints: ['Those environment variables must not point to opencode.'],
        },
      },
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.testModel('openrouter', modelId);
    });

    expect(state?.error).toBe('OpenCode provider settings are using the wrong runtime binary.');
    expect(state?.errorDiagnostics?.binaryPath).toBe('/opt/homebrew/bin/opencode');
    expect(state?.modelResults[modelId]).toMatchObject({
      ok: false,
      message: 'OpenCode provider settings are using the wrong runtime binary.',
    });
  });

  it('keeps successful model probes scoped to the model card instead of a global success banner', async () => {
    const modelId = 'openrouter/openai/gpt-oss-20b:free';
    installRuntimeProviderManagementApi({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'openrouter',
        modelId,
        ok: true,
        availability: 'available',
        message: 'Model probe passed',
        diagnostics: [],
      },
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.testModel('openrouter', modelId);
    });

    expect(state?.successMessage).toBeNull();
    expect(state?.error).toBeNull();
    expect(state?.modelResults[modelId]?.ok).toBe(true);
    expect(state?.modelResults[modelId]?.message).toBe('Model probe passed');
  });

  it('keeps a successful set-default probe visible as verified model state', async () => {
    const modelId = 'llama.cpp/qwen-test:0.5b';
    const setDefaultModel = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          defaultModel: modelId,
          configuredModels: [
            {
              providerId: 'llama.cpp',
              modelId,
              displayName: 'qwen-test:0.5b',
              sourceLabel: 'llama.cpp',
              free: false,
              default: true,
              availability: 'untested',
              accessKind: 'configured_authless',
              routeKind: 'configured_local',
              proofState: 'needs_probe',
              requiresExecutionProof: true,
              accessReason: 'Execution proof required',
            },
          ],
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          setDefaultModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.setDefaultModel('llama.cpp', modelId);
      await Promise.resolve();
    });

    expect(setDefaultModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId,
      probe: true,
      scope: 'project',
      projectPath: null,
    });
    expect(state?.view?.configuredModels?.[0]).toMatchObject({
      modelId,
      default: true,
      availability: 'available',
      accessKind: 'verified',
      proofState: 'verified',
      requiresExecutionProof: false,
    });
    expect(state?.modelResults[modelId]).toMatchObject({
      ok: true,
      availability: 'available',
      message: 'Model probe passed',
    });
  });

  it('keeps the effective project default selected when an all-projects default is shadowed', async () => {
    const allProjectsModelId = 'llama.cpp/qwen-test:0.5b';
    const projectModelId = 'llama.cpp/project-test:1b';
    const setDefaultModel = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          ...createRuntimeView(),
          defaultModel: projectModelId,
          projectDefaultModel: projectModelId,
          allProjectsDefaultModel: allProjectsModelId,
          defaultModelSource: 'project',
          configuredModels: [
            {
              providerId: 'llama.cpp',
              modelId: allProjectsModelId,
              displayName: 'qwen-test:0.5b',
              sourceLabel: 'llama.cpp',
              free: false,
              default: false,
              availability: 'untested',
              accessKind: 'configured_authless',
              routeKind: 'configured_local',
              proofState: 'needs_probe',
              requiresExecutionProof: true,
              accessReason: 'Execution proof required',
            },
            {
              providerId: 'llama.cpp',
              modelId: projectModelId,
              displayName: 'project-test:1b',
              sourceLabel: 'llama.cpp',
              free: false,
              default: true,
              availability: 'available',
              accessKind: 'verified',
              routeKind: 'configured_local',
              proofState: 'verified',
              requiresExecutionProof: false,
              accessReason: null,
            },
          ],
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          setDefaultModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.setDefaultModel('llama.cpp', allProjectsModelId, 'all_projects');
      await Promise.resolve();
    });

    expect(state?.selectedModelId).toBe(projectModelId);
    expect(state?.view?.defaultModel).toBe(projectModelId);
    expect(state?.view?.defaultModelSource).toBe('project');
    expect(
      state?.view?.configuredModels?.find((model) => model.modelId === allProjectsModelId)
    ).toMatchObject({
      default: false,
      availability: 'available',
      accessKind: 'verified',
      proofState: 'verified',
    });
    expect(
      state?.view?.configuredModels?.find((model) => model.modelId === projectModelId)
    ).toMatchObject({
      default: true,
      accessKind: 'verified',
    });
  });
});
