import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type RuntimeProviderManagementActions,
  type RuntimeProviderManagementState,
  useRuntimeProviderManagement,
} from '@features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';
import { resetRuntimeProviderDirectoryCacheForTests } from '@features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';
import { RuntimeProviderManagementPanelView } from '@features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementViewDto,
  RuntimeProviderModelDto,
} from '@features/runtime-provider-management/contracts';
import type { ElectronAPI } from '@shared/types/api';

const projectPath = '/TEST/anonymous-model-project';
const model: RuntimeProviderModelDto = {
  modelId: 'opencode/big-pickle',
  providerId: 'opencode',
  displayName: 'TEST anonymous free model',
  sourceLabel: 'OpenCode catalog',
  free: true,
  default: false,
  availability: 'untested',
  accessKind: 'builtin_free',
  routeKind: 'builtin_free',
  proofState: 'needs_probe',
  requiresExecutionProof: true,
};
const compact: RuntimeProviderConnectionDto = {
  providerId: 'opencode',
  displayName: 'OpenCode Zen',
  state: 'available',
  ownership: [],
  recommended: false,
  modelCount: 0,
  defaultModelId: null,
  authMethods: ['api'],
  actions: [],
  detail: null,
};
const view: RuntimeProviderManagementViewDto = {
  runtimeId: 'opencode',
  title: 'OpenCode',
  runtime: {
    state: 'ready',
    cliPath: '/TEST/opencode',
    version: '2.2.0',
    managedProfile: 'active',
    localAuth: 'missing',
  },
  // A compact snapshot can report no connected models while the directory has public models.
  providers: [{ ...compact, providerId: 'openai', displayName: 'OpenAI' }, compact],
  configuredModels: [],
  projectPath,
  projectDefaultModel: null,
  allProjectsDefaultModel: null,
  defaultModelSource: null,
  defaultModel: null,
  fallbackModel: null,
  diagnostics: [],
};
let root: Root | undefined;
let host: HTMLDivElement;
let state: RuntimeProviderManagementState;
let actions: RuntimeProviderManagementActions;
const originalApi = window.electronAPI;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  resetRuntimeProviderDirectoryCacheForTests();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  vi.unstubAllGlobals();
});

async function mount(use: 'enabled' | 'disabled' | 'missing', initialProvider = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const entry: RuntimeProviderDirectoryEntryDto = {
    ...compact,
    setupKind: 'available-readonly',
    modelCount: 9,
    sources: ['opencode-provider'],
    sourceLabel: 'OpenCode catalog',
    providerSource: null,
    actions: [
      ...(use === 'missing'
        ? []
        : [
            {
              id: 'use' as const,
              label: 'View models',
              enabled: use === 'enabled',
              disabledReason: use === 'disabled' ? 'Unavailable' : null,
              requiresSecret: false,
              ownershipScope: 'runtime' as const,
            },
          ]),
      {
        id: 'connect',
        label: 'Connect',
        enabled: true,
        disabledReason: null,
        requiresSecret: true,
        ownershipScope: 'managed',
      },
    ],
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: true,
      configuredAuthless: false,
    },
  };
  const directory: RuntimeProviderManagementDirectoryResponse = {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries: [entry],
      totalCount: 1,
      returnedCount: 1,
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      nextCursor: null,
      fetchedAt: new Date().toISOString(),
      diagnostics: [],
    },
  };
  let resolveModels!: (value: RuntimeProviderManagementModelsResponse) => void;
  const pendingModels = new Promise<RuntimeProviderManagementModelsResponse>((resolve) => {
    resolveModels = resolve;
  });
  const loadModels = vi.fn(() => pendingModels);
  let resolveDirectory!: (value: RuntimeProviderManagementDirectoryResponse) => void;
  const pendingDirectory = new Promise<RuntimeProviderManagementDirectoryResponse>((resolve) => {
    resolveDirectory = resolve;
  });
  const loadProviderDirectory = vi.fn(() => pendingDirectory);
  const loadSetupForm = vi.fn(async () => ({
    schemaVersion: 1,
    runtimeId: 'opencode',
    setupForm: {
      runtimeId: 'opencode',
      providerId: 'opencode',
      displayName: 'OpenCode Zen',
      method: 'api',
      supported: true,
      title: 'Connect OpenCode Zen',
      description: null,
      submitLabel: 'Connect',
      disabledReason: null,
      source: 'curated',
      secret: { key: 'key', label: 'API key', placeholder: 'Paste API key', required: true },
      prompts: [],
    },
  }));
  const testModel = vi.fn();
  const connectProvider = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      runtimeProviderManagement: {
        loadView: vi.fn(async () => ({ schemaVersion: 1, runtimeId: 'opencode', view })),
        loadProviderDirectory,
        loadModels,
        loadSetupForm,
        testModel,
        connectProvider,
      },
    } as unknown as ElectronAPI,
  });
  function Harness() {
    [state, actions] = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: true,
      projectPath,
      searchDirectoryOnQueryChange: false,
      initialProviderId: initialProvider ? 'opencode' : undefined,
    });
    return (
      <RuntimeProviderManagementPanelView
        state={state}
        actions={actions}
        disabled={false}
        projectPath={projectPath}
      />
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  await act(async () => {
    await vi.waitFor(() => expect(loadProviderDirectory).toHaveBeenCalledTimes(1));
  });
  await act(async () => resolveDirectory(directory));
  expect(state.directoryLoaded).toBe(true);
  return { loadModels, resolveModels, loadSetupForm, testModel, connectProvider };
}

describe('anonymous directory models through the real management hook and view', () => {
  it.each(['row click', 'provider selection', 'initial provider'] as const)(
    'opens and loads public V2 models through %s without connecting or probing',
    async (entryPoint) => {
      const api = await mount('enabled', entryPoint === 'initial provider');
      if (entryPoint === 'row click') {
        expect(state.modelPickerProviderId).toBeNull();
        const row = host.querySelector<HTMLElement>(
          '[data-testid="runtime-provider-directory-row-opencode"]'
        );
        expect(row?.getAttribute('role')).toBe('button');
        await act(async () => row!.click());
      } else if (entryPoint === 'provider selection') {
        await act(async () => actions.selectProvider('opencode'));
      }
      expect(state.selectedProviderId).toBe('opencode');
      expect(state.modelPickerProviderId).toBe('opencode');
      expect(state.modelsLoading).toBe(true);
      expect(api.loadModels).toHaveBeenCalledTimes(1);
      expect(api.loadModels).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: 'opencode',
          providerId: 'opencode',
          projectPath,
        })
      );
      await act(async () =>
        api.resolveModels({
          schemaVersion: 1,
          runtimeId: 'opencode',
          models: {
            runtimeId: 'opencode',
            providerId: 'opencode',
            models: [model],
            defaultModelId: null,
            diagnostics: [],
          },
        })
      );
      expect(state.modelPickerProviderId).toBe('opencode');
      expect(state.modelsLoading).toBe(false);
      expect(state.models).toEqual([model]);
      const picker = host.querySelector('[data-testid="runtime-provider-model-list"]');
      expect(picker?.textContent).toContain(model.displayName);
      expect(
        picker?.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
      ).toBeNull();
      expect(api.loadSetupForm).not.toHaveBeenCalled();
      expect(api.connectProvider).not.toHaveBeenCalled();
      expect(api.testModel).not.toHaveBeenCalled();

      const header = host.querySelector<HTMLElement>(
        '[data-testid="runtime-provider-directory-row-opencode-header"]'
      );
      const connect = [...header!.querySelectorAll('button')].find(
        (button) => button.textContent === 'Connect'
      );
      expect(connect?.disabled).toBe(false);
      await act(async () => connect!.click());
      expect(api.loadSetupForm).toHaveBeenCalledTimes(1);
      expect(state.activeFormProviderId).toBe('opencode');
      expect(state.setupForm?.providerId).toBe('opencode');
      expect(state.modelPickerProviderId).toBeNull();
      expect(api.loadModels).toHaveBeenCalledTimes(1);
      expect(api.connectProvider).not.toHaveBeenCalled();
      expect(api.testModel).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'disabled'] as const)(
    'does not load anonymous models with %s Use',
    async (use) => {
      const api = await mount(use);
      await act(async () => actions.selectDirectoryProvider('opencode'));
      expect(state.modelPickerProviderId).toBeNull();
      expect(state.modelsLoading).toBe(false);
      expect(api.loadModels).not.toHaveBeenCalled();
    }
  );
});
