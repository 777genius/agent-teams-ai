import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useCreateTeamLaunchModel } from '@renderer/components/team/dialogs/useCreateTeamLaunchModel';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { context } = vi.hoisted(() => ({
  context: {
    activeContextId: 'TEST-local',
    targetContextId: null as string | null,
    isContextSwitching: false,
    connectionMode: 'local',
    connectedHost: null as string | null,
    appConfig: { general: { claudeRootPath: '/TEST-claude' } },
  },
}));
vi.mock('@renderer/store', () => ({
  useStore: (select: (value: typeof context) => unknown) => select(context),
}));
let dispose = () => {};
afterEach(() => {
  dispose();
  context.activeContextId = 'TEST-local';
  context.targetContextId = null;
  context.connectionMode = 'local';
  context.connectedHost = null;
  context.isContextSwitching = false;
  context.appConfig.general.claudeRootPath = '/TEST-claude';
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const provider = createLoadingMultimodelCliStatus().providers.find(
    (row) => row.providerId === 'anthropic'
  )!;
  const input: Parameters<typeof useCreateTeamLaunchModel>[0] = {
    open: true,
    selectedModel: 'claude-opus-4-6',
    limitContext: false,
    providerId: 'anthropic',
    providerStatus: {
      ...provider,
      modelCatalogRefreshState: 'ready',
      connection: {
        supportsOAuth: false,
        supportsApiKey: true,
        configurableAuthModes: [],
        configuredAuthMode: 'auto',
        apiKeyConfigured: true,
        apiKeySource: 'stored',
      },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-10-22T00:00:00.000Z',
        staleAt: '2099-10-22T00:00:00.000Z',
        defaultModelId: 'claude-opus-4-6',
        defaultLaunchModel: 'claude-opus-4-6',
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        models: [
          {
            id: 'claude-opus-4-6',
            launchModel: 'claude-opus-4-6',
            displayName: 'Opus 4.6',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
      },
    },
  };
  let output: string | undefined;
  function View() {
    output = useCreateTeamLaunchModel(input);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(<View />));
  render();
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  return {
    input,
    render,
    output: () => output,
    loading() {
      input.providerStatus = {
        ...input.providerStatus!,
        modelCatalogRefreshState: 'loading',
        modelCatalog: null,
      };
      render();
    },
  };
}

describe('Create exact model during passive discovery', () => {
  it('preserves a resolved model only while the same explicit selection is loading, then accepts new settled catalog', () => {
    const f = mount();
    expect(f.output()).toBe('claude-opus-4-6');
    const catalog = structuredClone(f.input.providerStatus!.modelCatalog!);
    f.loading();
    expect(f.output()).toBe('claude-opus-4-6');
    catalog.models[0]!.launchModel = 'claude-opus-4-6[1m]';
    f.input.providerStatus = {
      ...f.input.providerStatus!,
      modelCatalogRefreshState: 'ready',
      modelCatalog: catalog,
    };
    f.render();
    expect(f.output()).toBe('claude-opus-4-6[1m]');
    expect(f.input.providerStatus.authenticated).toBe(false);
  });
  it.each([
    'model',
    'limit',
    'provider',
    'backend',
    'endpoint',
    'auth',
    'active',
    'target',
    'switching',
    'connection',
    'host',
    'root',
    'close',
  ] as const)('does not carry the old resolution across %s changes while loading', (change) => {
    const f = mount();
    f.loading();
    expect(f.output()).toBe('claude-opus-4-6');
    if (change === 'model') f.input.selectedModel = 'claude-opus-4-7';
    if (change === 'limit') f.input.limitContext = true;
    if (change === 'provider') {
      f.input.providerId = 'codex';
      f.render();
      f.input.providerId = 'anthropic';
    }
    if (change === 'backend') f.input.providerStatus!.selectedBackendId = 'cli-sdk';
    if (change === 'endpoint')
      f.input.providerStatus!.connection!.compatibleEndpoint = {
        enabled: true,
        baseUrl: 'http://TEST.local',
        tokenConfigured: true,
        tokenSource: 'stored',
      };
    if (change === 'auth') f.input.providerStatus!.connection!.configuredAuthMode = 'api_key';
    if (change === 'active') context.activeContextId = 'TEST-other';
    if (change === 'target') context.targetContextId = 'TEST-target';
    if (change === 'switching') context.isContextSwitching = true;
    if (change === 'connection') context.connectionMode = 'ssh';
    if (change === 'host') context.connectedHost = 'TEST-host';
    if (change === 'root') context.appConfig.general.claudeRootPath = '/TEST-other-root';
    if (change === 'close') f.input.open = false;
    f.render();
    expect(f.output()).toBe(
      change === 'model'
        ? 'claude-opus-4-7[1m]'
        : change === 'limit'
          ? 'claude-opus-4-6'
          : 'claude-opus-4-6[1m]'
    );
  });
});
