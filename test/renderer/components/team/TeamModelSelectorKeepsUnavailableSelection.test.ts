import React, { act } from 'react';
import { createRoot as createReactRoot, type Root } from 'react-dom/client';

import {
  publishRuntimeProviderDirectoryCache,
  resetRuntimeProviderDirectoryCacheForTests,
} from '@features/runtime-provider-management/renderer/runtimeProviderDirectoryCache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type {
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelsResponse,
} from '@features/runtime-provider-management/contracts';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { ElectronAPI } from '@shared/types/api';

const mountedRoots = new Set<Root>();

function createRoot(container: Element | DocumentFragment): Root {
  const reactRoot = createReactRoot(container);
  let mounted = true;
  const trackedRoot: Root = {
    render: (children) => reactRoot.render(children),
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      mountedRoots.delete(trackedRoot);
      reactRoot.unmount();
    },
  };
  mountedRoots.add(trackedRoot);
  return trackedRoot;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerModelsResponse(
  providerId: string,
  modelIds: readonly string[] = [],
  options: {
    catalogState?: 'fresh' | 'stale';
    error?: string;
  } = {}
): RuntimeProviderManagementModelsResponse {
  if (options.error) {
    return {
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: { code: 'runtime-unhealthy', message: options.error, recoverable: true },
    };
  }
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId,
      models: modelIds.map((modelId, index) => ({
        modelId,
        providerId,
        displayName: modelId.slice(modelId.indexOf('/') + 1),
        sourceLabel: providerId === 'opencode' ? 'OpenCode Zen' : providerId,
        free: providerId === 'opencode',
        default: index === 0,
        availability: 'available',
        accessKind: providerId === 'opencode' ? 'builtin_free' : 'credentialed',
        routeKind: providerId === 'opencode' ? 'builtin_free' : 'connected_provider',
        accessReason: null,
      })),
      defaultModelId: modelIds[0] ?? null,
      diagnostics: [],
      catalogState: options.catalogState ?? 'fresh',
      nextCursor: null,
    },
  };
}

function installLoadModelsApi(
  loadModels: (
    input: RuntimeProviderManagementLoadModelsInput
  ) => Promise<RuntimeProviderManagementModelsResponse>,
  listLocalProviders: (
    input: RuntimeLocalProviderListInput
  ) => Promise<RuntimeLocalProviderListResponse> = async (input) => ({
    schemaVersion: 1,
    runtimeId: 'opencode',
    scope: input.scope,
    providers: [],
  })
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      runtimeProviderManagement: { listLocalProviders, loadModels },
    } as unknown as ElectronAPI,
  });
}

async function resolveDeferred<T>(deferred: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    deferred.resolve(value);
    await deferred.promise;
    await Promise.resolve();
  });
}

async function hydrateFailClosedAuthorityClocks(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// Real-timer counterpart for tests that keep real timers: the fail-closed
// authority clocks publish their first reading from a setTimeout(0) callback,
// and that dispatch only flushes when awaited inside act().
async function flushFailClosedAuthorityClocks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

vi.mock('@renderer/components/ui/tabs', () => {
  let currentValue = '';
  let currentOnValueChange: ((value: string) => void) | null = null;

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange?: (value: string) => void;
    }) => {
      currentValue = value;
      currentOnValueChange = onValueChange ?? null;
      return React.createElement('div', { 'data-tabs-value': value }, children);
    },
    TabsList: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)
    ),
    TabsTrigger: ({
      children,
      value,
      disabled,
      onClick,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) =>
      React.createElement(
        'button',
        {
          ...props,
          type: 'button',
          role: 'tab',
          disabled,
          'data-state': currentValue === value ? 'active' : 'inactive',
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            onClick?.(event);
            if (!disabled) {
              currentOnValueChange?.(value);
            }
          },
        },
        children
      ),
  };
});

const storeState = {
  cliStatus: null as unknown,
  cliStatusLoading: false,
  cliProviderStatusLoading: {} as Record<string, boolean>,
  cliProviderStatusByScope: {} as Record<string, unknown>,
  cliProviderStatusScopeRevision: 0,
  appConfig: { general: { multimodelEnabled: true } },
  fetchCliProviderStatus: vi.fn().mockResolvedValue(undefined),
  openCodeRuntimeStatus: null as OpenCodeRuntimeStatus | null,
  openCodeRuntimeStatusLoading: false,
  openCodeRuntimeError: null as string | null,
  fetchOpenCodeRuntimeStatus: vi.fn().mockResolvedValue(undefined),
  codexRuntimeStatus: null as CodexRuntimeStatus | null,
  codexRuntimeStatusLoading: false,
  codexRuntimeError: null as string | null,
  fetchCodexRuntimeStatus: vi.fn().mockResolvedValue(undefined),
  installCodexRuntime: vi.fn().mockResolvedValue(undefined),
};
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(undefined)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

const useVirtualizerMock = vi.fn(
  (options: { count: number }) =>
    ({
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 9) }, (_, index) => ({
          index,
          key: index,
          start: index * 92,
          size: 92,
        })),
      getTotalSize: () => options.count * 92,
      measureElement: () => undefined,
    }) as const
);

vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: (range: {
    startIndex: number;
    endIndex: number;
    overscan: number;
    count: number;
  }) => {
    const start = Math.max(range.startIndex - range.overscan, 0);
    const end = Math.min(range.endIndex + range.overscan, range.count - 1);
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  },
  useVirtualizer: (options: { count: number }) => useVirtualizerMock(options),
}));

import { TeamModelSelector } from '@renderer/components/team/dialogs/TeamModelSelector';
import { LeadModelRow } from '@renderer/components/team/members/LeadModelRow';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { getTeamModelSelectionError } from '@renderer/utils/teamModelAvailability';

const PROJECT = '/tmp/keep-unavailable-selection';
const GO_MODEL = 'opencode-go/space-bunny-free';
const ZEN_MODEL = 'opencode/big-pickle';

function zenCatalogProvider() {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    capabilities: { teamLaunch: true, oneShot: false },
    models: [ZEN_MODEL],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-09-25T11:59:00.000Z',
      staleAt: '2099-01-01T00:00:00.000Z',
      defaultModelId: ZEN_MODEL,
      defaultLaunchModel: ZEN_MODEL,
      models: [
        {
          id: ZEN_MODEL,
          launchModel: ZEN_MODEL,
          displayName: 'big-pickle',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
          metadata: {
            free: true,
            opencode: {
              providerId: 'opencode',
              modelId: 'big-pickle',
              sourceLabel: 'OpenCode Zen',
              accessKind: 'builtin_free',
              routeKind: 'builtin_free',
              proofState: 'not_required',
              requiresExecutionProof: false,
              reason: null,
            },
          },
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    modelVerificationState: 'idle',
    modelAvailability: [],
  };
}

describe('TeamModelSelector keeps an unavailable saved selection', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of [...mountedRoots]) {
        root.unmount();
      }
      await Promise.resolve();
    });
    resetRuntimeProviderDirectoryCacheForTests();
    document.body.innerHTML = '';
    Reflect.deleteProperty(window, 'electronAPI');
    storeState.cliStatus = null;
    storeState.cliProviderStatusByScope = {};
    storeState.fetchCliProviderStatus.mockReset().mockResolvedValue(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderWithGoSelection(goCatalog: RuntimeProviderManagementModelsResponse) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('EventSource', undefined);
    const loadModels = vi.fn(async (input: RuntimeProviderManagementLoadModelsInput) =>
      input.providerId === 'opencode-go'
        ? goCatalog
        : providerModelsResponse(input.providerId, [ZEN_MODEL])
    );
    installLoadModelsApi(loadModels);
    const provider = zenCatalogProvider();
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', PROJECT)]: provider,
    };
    publishRuntimeProviderDirectoryCache({
      projectPath: null,
      fetchedAt: '2026-09-25T12:00:00.000Z',
      authoritative: true,
      entries: [],
    });
    const onValueChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: GO_MODEL,
          onValueChange,
          projectPath: PROJECT,
        })
      );
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(loadModels).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'opencode-go' })
      )
    );
    await flushFailClosedAuthorityClocks();
    await flushFailClosedAuthorityClocks();
    return { host, onValueChange };
  }

  function findSelectedGoCard(host: HTMLElement): HTMLElement | undefined {
    return Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid="team-model-selector-model-option"]')
    ).find((element) => element.textContent?.includes('space-bunny-free'));
  }

  it('does not silently replace a model its own fresh catalog no longer lists', async () => {
    const { host, onValueChange } = await renderWithGoSelection(
      providerModelsResponse('opencode-go', [])
    );
    expect(onValueChange).not.toHaveBeenCalledWith('');
    const card = findSelectedGoCard(host);
    expect(card).toBeDefined();
    expect(card?.getAttribute('aria-pressed')).toBe('true');
    expect(card?.getAttribute('aria-disabled')).toBe('true');
    expect(card?.getAttribute('aria-label')).toContain(
      'This model is not available from its provider right now.'
    );
  });

  it('keeps the selection when the catalog request fails, as before', async () => {
    const { onValueChange } = await renderWithGoSelection(
      providerModelsResponse('opencode-go', [], { error: 'provider catalog timed out' })
    );
    expect(onValueChange).not.toHaveBeenCalledWith('');
  });

  it('preserves the saved Claude model when opening the real lead picker across catalog refreshes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('EventSource', undefined);
    installLoadModelsApi(async (input) => providerModelsResponse(input.providerId));
    const savedModel = 'claude-sonnet-4-6';
    const catalog = (models: string[]): CliProviderStatus => ({
      providerId: 'anthropic',
      displayName: 'Claude',
      supported: true,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: {
          plugins: { status: 'unsupported', ownership: 'shared' },
          mcp: { status: 'unsupported', ownership: 'shared' },
          skills: { status: 'unsupported', ownership: 'shared' },
          apiKeys: { status: 'unsupported', ownership: 'provider-scoped' },
        },
      },
      models, modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1, providerId: 'anthropic', source: 'claude-sdk', status: 'ready',
        fetchedAt: '2026-11-26T12:00:00.000Z', staleAt: '2099-01-01T00:00:00.000Z',
        defaultModelId: null, defaultLaunchModel: null,
        models: models.map((model) => ({
          id: model, launchModel: model, displayName: model, hidden: false,
          supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: null,
          inputModalities: [], supportsPersonality: false, isDefault: false,
          upgrade: false, source: 'claude-sdk',
        })),
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    });
    let provider = catalog(['claude-opus-4-6']);
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
    const onModelChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () => root.render(React.createElement(LeadModelRow, {
      providerId: 'anthropic', model: savedModel, effort: 'low', limitContext: true,
      preserveSelectedModel: true,
      projectPath: '/TEST/saved-claude-review', syncModelsWithTeammates: true,
      onProviderChange: vi.fn(), onModelChange, onEffortChange: vi.fn(),
      onLimitContextChange: vi.fn(), onSyncModelsWithTeammatesChange: vi.fn(),
      modelIssueText: getTeamModelSelectionError('anthropic', savedModel, provider),
    }));
    await act(async () => { render(); });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label*=" provider,"]');
    expect(trigger?.getAttribute('aria-label')).toContain('Sonnet 4.6');
    expect(onModelChange).not.toHaveBeenCalled();
    await act(async () => { trigger!.click(); });
    await flushFailClosedAuthorityClocks();
    expect(onModelChange).not.toHaveBeenCalled();
    expect(trigger?.getAttribute('aria-label')).toContain('Sonnet 4.6');
    expect(getTeamModelSelectionError('anthropic', savedModel, provider)).not.toBeNull();
    expect(provider.capabilities.teamLaunch).toBe(false);
    provider = catalog(['claude-opus-4-6', savedModel]);
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
    await act(async () => { render(); });
    await flushFailClosedAuthorityClocks();
    expect(onModelChange).not.toHaveBeenCalled();
    expect(getTeamModelSelectionError('anthropic', savedModel, provider)).toBeNull();
    const selected = host.querySelector<HTMLElement>(
      '[data-testid="team-model-selector-model-option"][aria-pressed="true"]'
    );
    expect(selected?.textContent).toContain('Sonnet 4.6');
    const defaultChoice = Array.from(host.querySelectorAll<HTMLButtonElement>(
      '[data-testid="team-model-selector-model-option"]'
    )).find((button) => button.textContent?.includes('Default'));
    expect(defaultChoice).toBeDefined();
    await act(async () => { defaultChoice!.click(); });
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith('');
  });
});
