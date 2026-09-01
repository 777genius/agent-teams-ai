import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderModelDto,
} from '@features/runtime-provider-management/contracts';
import type { CliProviderModelCatalogItem, CliProviderStatus } from '@shared/types';

const apiMocks = vi.hoisted(() => ({
  loadModels: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      loadModels: (...args: unknown[]) => apiMocks.loadModels(...args),
    },
  },
}));

import {
  type OpenCodeProviderModelCatalogResult,
  resolveOpenCodeCatalogSourceProviderId,
  useOpenCodeProviderModelCatalog,
} from '@features/runtime-provider-management/renderer';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(
  providerId: string,
  modelId: string,
  overrides: Partial<RuntimeProviderModelDto> = {}
): RuntimeProviderModelDto {
  return {
    modelId,
    providerId,
    displayName: modelId,
    sourceLabel: providerId,
    free: providerId === 'opencode',
    default: false,
    availability: 'available',
    accessKind: providerId === 'opencode' ? 'builtin_free' : 'credentialed',
    routeKind: providerId === 'opencode' ? 'builtin_free' : 'connected_provider',
    proofState: 'verified',
    requiresExecutionProof: false,
    accessReason: null,
    ...overrides,
  };
}

function response(input: {
  providerId: string;
  models?: readonly RuntimeProviderModelDto[];
  defaultModelId?: string | null;
  catalogState?: 'fresh' | 'stale';
  nextCursor?: string | null;
}): RuntimeProviderManagementModelsResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: input.providerId,
      models: input.models ?? [],
      defaultModelId: input.defaultModelId ?? null,
      diagnostics: [],
      ...(input.catalogState ? { catalogState: input.catalogState } : {}),
      nextCursor: input.nextCursor ?? null,
    },
  };
}

function passiveStatus(models: string[] = []): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    statusMessage: 'Passive status only',
    detailMessage: null,
    models,
    modelCatalog: null,
    modelCatalogRefreshState: 'loading',
    modelAvailability: [],
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped', reason: null },
        mcp: { status: 'read-only', ownership: 'provider-scoped', reason: null },
        skills: { status: 'read-only', ownership: 'provider-scoped', reason: null },
        apiKeys: { status: 'read-only', ownership: 'provider-scoped', reason: null },
      },
    },
    backend: { kind: 'opencode', label: 'OpenCode' },
  };
}

function passiveCatalogModel(
  modelId: string,
  providerId = 'deepinfra'
): CliProviderModelCatalogItem {
  return {
    id: modelId,
    launchModel: modelId,
    displayName: modelId,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: false,
    upgrade: false,
    source: 'app-server',
    metadata: {
      opencode: {
        providerId,
        modelId,
        sourceLabel: providerId,
        accessKind: 'credentialed',
        routeKind: 'connected_provider',
        proofState: 'needs_probe',
        requiresExecutionProof: true,
        reason: null,
      },
    },
  };
}

interface HarnessProps {
  enabled?: boolean;
  sourceProviderId: string | null;
  projectPath?: string | null;
  passiveProviderStatus?: CliProviderStatus;
}

let observed: OpenCodeProviderModelCatalogResult | null = null;
let host: HTMLDivElement;
let root: Root;

function Harness(props: HarnessProps): React.ReactElement {
  observed = useOpenCodeProviderModelCatalog({
    enabled: props.enabled ?? true,
    sourceProviderId: props.sourceProviderId,
    projectPath: props.projectPath,
    passiveProviderStatus: props.passiveProviderStatus ?? passiveStatus(),
  });
  return React.createElement('div');
}

async function renderHarness(props: HarnessProps): Promise<void> {
  await act(async () => {
    root.render(React.createElement(Harness, props));
    await Promise.resolve();
  });
}

async function waitForStatus(status: OpenCodeProviderModelCatalogResult['status']): Promise<void> {
  await vi.waitFor(() => expect(observed?.status).toBe(status));
}

describe('resolveOpenCodeCatalogSourceProviderId', () => {
  const resolveSource = (
    overrides: Partial<Parameters<typeof resolveOpenCodeCatalogSourceProviderId>[0]>
  ): string | null =>
    resolveOpenCodeCatalogSourceProviderId({
      selectedSourceIds: new Set(),
      selectedModel: null,
      knownLocalSourceIds: new Set(),
      localProviderLookupReady: true,
      ...overrides,
    });

  it('allows explicit remote and built-in source selections while lookup is pending', () => {
    expect(
      resolveSource({ selectedSourceIds: new Set([' DeepInfra ']), localProviderLookupReady: false })
    ).toBe('deepinfra');
    expect(
      resolveSource({ selectedSourceIds: new Set(['opencode']), localProviderLookupReady: false })
    ).toBe('opencode');
  });

  it('suppresses built-in and known custom local ownership', () => {
    expect(resolveSource({ selectedSourceIds: new Set(['ollama']) })).toBeNull();
    expect(
      resolveSource({
        selectedModel: 'corp-local/model',
        knownLocalSourceIds: new Set(['corp-local']),
      })
    ).toBeNull();
    expect(resolveSource({ selectedModel: 'deepinfra/model', localModelsSelected: true })).toBeNull();
  });

  it('fails closed for unresolved, ambiguous, and malformed model-derived ownership', () => {
    expect(
      resolveSource({ selectedModel: 'OpenRouter/model', localProviderLookupReady: false })
    ).toBeNull();
    expect(resolveSource({ selectedModel: 'OpenRouter/model' })).toBe('openrouter');
    expect(resolveSource({ selectedModel: 'deepinfra//model' })).toBeNull();
    expect(
      resolveSource({ selectedSourceIds: new Set(['deepinfra', 'openrouter']) })
    ).toBeNull();
  });
});

describe('useOpenCodeProviderModelCatalog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMocks.loadModels.mockReset();
    observed = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads every page for one project/provider and preserves valid qualified IDs', async () => {
    apiMocks.loadModels.mockImplementation(
      async (input: RuntimeProviderManagementLoadModelsInput) =>
        input.cursor
          ? response({
              providerId: 'deepinfra',
              models: [model('deepinfra', 'second-model')],
              defaultModelId: 'deepinfra/org/first-model',
              catalogState: 'fresh',
            })
          : response({
              providerId: 'deepinfra',
              models: [model('deepinfra', 'deepinfra/org/first-model')],
              catalogState: 'fresh',
              nextCursor: 'page-2',
            })
    );

    await renderHarness({ sourceProviderId: 'deepinfra', projectPath: '/projects/one' });
    await waitForStatus('ready');

    expect(apiMocks.loadModels).toHaveBeenCalledTimes(2);
    expect(apiMocks.loadModels.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        runtimeId: 'opencode',
        providerId: 'deepinfra',
        projectPath: '/projects/one',
        cursor: null,
      }),
      expect.objectContaining({
        runtimeId: 'opencode',
        providerId: 'deepinfra',
        projectPath: '/projects/one',
        cursor: 'page-2',
      }),
    ]);
    expect(observed?.providerStatus?.models).toEqual([
      'deepinfra/org/first-model',
      'deepinfra/second-model',
    ]);
    expect(observed?.providerStatus?.modelCatalog?.defaultModelId).toBe(
      'deepinfra/org/first-model'
    );
    expect(observed?.providerStatus?.modelCatalog?.models[0]?.metadata?.opencode).toMatchObject({
      proofState: 'needs_probe',
      requiresExecutionProof: true,
    });
  });

  it.each([
    ['foreign model provider', [model('kiro', 'kiro/poisoned')], null],
    ['foreign qualified model', [model('deepinfra', 'kiro/poisoned')], null],
    ['foreign qualified default', [model('deepinfra', 'deepinfra/valid')], 'kiro/poisoned'],
  ] as const)('fails closed for a %s', async (_label, models, defaultModelId) => {
    apiMocks.loadModels.mockResolvedValue(
      response({ providerId: 'deepinfra', models, defaultModelId, catalogState: 'fresh' })
    );

    await renderHarness({
      sourceProviderId: 'deepinfra',
      passiveProviderStatus: passiveStatus(['deepinfra/cached']),
    });
    await waitForStatus('error');

    expect(observed?.providerStatus?.models).toEqual(['deepinfra/cached']);
    expect(observed?.providerStatus?.models).not.toContain('kiro/poisoned');
    expect(observed?.error).toContain('foreign');
  });

  it.each(['/poisoned', 'deepinfra/', 'deepinfra//model'])(
    'fails closed for malformed model identifier %s',
    async (modelId) => {
      apiMocks.loadModels.mockResolvedValue(
        response({
          providerId: 'deepinfra',
          models: [model('deepinfra', modelId)],
          catalogState: 'fresh',
        })
      );

      await renderHarness({ sourceProviderId: 'deepinfra' });
      await waitForStatus('error');

      expect(observed?.providerStatus?.models).toEqual([]);
      expect(observed?.error).toContain('invalid model identifier');
    }
  );

  it.each(['/poisoned', 'deepinfra/', 'deepinfra//model'])(
    'fails closed for malformed default identifier %s',
    async (defaultModelId) => {
      apiMocks.loadModels.mockResolvedValue(
        response({
          providerId: 'deepinfra',
          models: [model('deepinfra', 'valid-model')],
          defaultModelId,
          catalogState: 'fresh',
        })
      );

      await renderHarness({ sourceProviderId: 'deepinfra' });
      await waitForStatus('error');

      expect(observed?.providerStatus?.models).toEqual([]);
      expect(observed?.error).toContain('invalid default model identifier');
    }
  );

  it('filters malformed and foreign passive models despite same-provider metadata', async () => {
    const failedRequest = createDeferred<RuntimeProviderManagementModelsResponse>();
    const passive = passiveStatus([
      '/poisoned',
      'deepinfra//model',
      'kiro/model',
      'deepinfra/org/nested-model',
      'unqualified-model',
    ]);
    passive.modelCatalog = {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'stale',
      fetchedAt: '2026-08-31T00:00:00.000Z',
      staleAt: '2026-08-31T00:00:00.000Z',
      defaultModelId: 'kiro/model',
      defaultLaunchModel: '/poisoned',
      models: [
        passiveCatalogModel('/poisoned'),
        passiveCatalogModel('deepinfra//model'),
        passiveCatalogModel('kiro/model'),
        passiveCatalogModel('deepinfra/org/nested-model'),
        passiveCatalogModel('unqualified-model'),
      ],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'degraded',
      },
    };
    apiMocks.loadModels.mockImplementation(() => failedRequest.promise);

    await renderHarness({ sourceProviderId: 'deepinfra', passiveProviderStatus: passive });
    await waitForStatus('loading');

    const expectSafeFallback = (): void => {
      expect(observed?.providerStatus?.models).toEqual([
        'deepinfra/org/nested-model',
        'unqualified-model',
      ]);
      expect(
        observed?.providerStatus?.modelCatalog?.models.map((catalogModel) => catalogModel.id)
      ).toEqual(['deepinfra/org/nested-model', 'unqualified-model']);
      expect(observed?.providerStatus?.modelCatalog?.defaultModelId).toBeNull();
      expect(observed?.providerStatus?.modelCatalog?.defaultLaunchModel).toBeNull();
    };
    expectSafeFallback();

    await act(async () => {
      failedRequest.reject(new Error('catalog timed out'));
      try {
        await failedRequest.promise;
      } catch {
        // The hook converts the rejected request into scoped error state.
      }
    });
    await waitForStatus('error');
    expectSafeFallback();
  });

  it('treats an omitted default as absent and uses the model marked default', async () => {
    const catalogResponse = response({
      providerId: 'deepinfra',
      models: [model('deepinfra', 'deepinfra/default-model', { default: true })],
      catalogState: 'fresh',
    });
    delete (catalogResponse.models as { defaultModelId?: string | null }).defaultModelId;
    apiMocks.loadModels.mockResolvedValue(catalogResponse);

    await renderHarness({ sourceProviderId: 'deepinfra' });
    await waitForStatus('ready');

    expect(observed?.providerStatus?.models).toEqual(['deepinfra/default-model']);
    expect(observed?.providerStatus?.modelCatalog?.defaultModelId).toBe(
      'deepinfra/default-model'
    );
    expect(observed?.providerStatus?.modelCatalog?.defaultLaunchModel).toBe(
      'deepinfra/default-model'
    );
  });

  it('treats missing freshness as degraded and never derives execution proof from catalog data', async () => {
    apiMocks.loadModels.mockResolvedValue(
      response({
        providerId: 'opencode',
        models: [model('opencode', 'opencode/free-model')],
        defaultModelId: 'opencode/free-model',
      })
    );

    await renderHarness({ sourceProviderId: 'opencode' });
    await waitForStatus('ready');

    expect(observed?.catalogState).toBeNull();
    expect(observed?.freshModelCount).toBeNull();
    expect(observed?.providerStatus).toMatchObject({
      authenticated: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'pending',
      capabilities: { teamLaunch: false },
      modelCatalog: { status: 'degraded' },
    });
    expect(observed?.providerStatus?.modelCatalog?.models[0]?.metadata?.opencode).toMatchObject({
      proofState: 'needs_probe',
      requiresExecutionProof: true,
    });
  });

  it('reports fresh scoped zero-model authority without treating stale data as authoritative', async () => {
    apiMocks.loadModels.mockResolvedValue(
      response({ providerId: 'deepinfra', models: [], catalogState: 'fresh' })
    );

    await renderHarness({ sourceProviderId: 'deepinfra' });
    await waitForStatus('ready');

    expect(observed?.freshModelCount).toBe(0);
    expect(observed?.providerStatus?.models).toEqual([]);
  });

  it('retains the last same-scope catalog across a refresh failure without elevating status', async () => {
    const failedRefresh = createDeferred<RuntimeProviderManagementModelsResponse>();
    apiMocks.loadModels
      .mockResolvedValueOnce(
        response({
          providerId: 'deepinfra',
          models: [model('deepinfra', 'deepinfra/kept-model')],
          catalogState: 'fresh',
        })
      )
      .mockImplementationOnce(() => failedRefresh.promise);

    await renderHarness({ sourceProviderId: 'deepinfra', projectPath: '/projects/keep' });
    await waitForStatus('ready');

    act(() => observed?.refresh());
    await waitForStatus('loading');
    expect(observed?.providerStatus?.models).toEqual(['deepinfra/kept-model']);

    await act(async () => {
      failedRefresh.reject(new Error('catalog timed out'));
      try {
        await failedRefresh.promise;
      } catch {
        // The hook converts the rejected request into scoped error state.
      }
    });
    await waitForStatus('error');

    expect(observed?.providerStatus).toMatchObject({
      authenticated: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'pending',
      capabilities: { teamLaunch: false },
      models: ['deepinfra/kept-model'],
      modelCatalog: { status: 'stale' },
      modelCatalogRefreshState: 'error',
    });
  });

  it('prevents a late old scope page from issuing another request or overwriting the new scope', async () => {
    const oldPage = createDeferred<RuntimeProviderManagementModelsResponse>();
    const newPage = createDeferred<RuntimeProviderManagementModelsResponse>();
    apiMocks.loadModels.mockImplementation(
      (input: RuntimeProviderManagementLoadModelsInput) =>
        input.projectPath === '/projects/old' ? oldPage.promise : newPage.promise
    );

    await renderHarness({ sourceProviderId: 'deepinfra', projectPath: '/projects/old' });
    await vi.waitFor(() => expect(apiMocks.loadModels).toHaveBeenCalledTimes(1));
    await renderHarness({ sourceProviderId: 'opencode', projectPath: '/projects/new' });
    await vi.waitFor(() => expect(apiMocks.loadModels).toHaveBeenCalledTimes(2));

    await act(async () => {
      oldPage.resolve(
        response({
          providerId: 'deepinfra',
          models: [model('deepinfra', 'deepinfra/old-model')],
          catalogState: 'fresh',
          nextCursor: 'must-not-load',
        })
      );
      await oldPage.promise;
      await Promise.resolve();
    });
    expect(apiMocks.loadModels).toHaveBeenCalledTimes(2);

    await act(async () => {
      newPage.resolve(
        response({
          providerId: 'opencode',
          models: [model('opencode', 'opencode/free-model')],
          catalogState: 'fresh',
        })
      );
      await newPage.promise;
      await Promise.resolve();
    });
    await waitForStatus('ready');

    expect(observed?.sourceProviderId).toBe('opencode');
    expect(observed?.providerStatus?.models).toEqual(['opencode/free-model']);
    expect(observed?.providerStatus?.models).not.toContain('deepinfra/old-model');
    const [oldInput, newInput] = apiMocks.loadModels.mock.calls.map(([input]) => input);
    expect(oldInput.requestGroupId).toBe(newInput.requestGroupId);
  });
});
