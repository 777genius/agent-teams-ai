import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  MAX_BROWSER_TIMEOUT_MS,
  resolveProjectScopedProviderStatus,
  useEffectiveCliProviderStatus,
} from '@renderer/hooks/useEffectiveCliProviderStatus';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliProviderStatus } from '@shared/types';

const storeState = {
  appConfig: { general: { multimodelEnabled: true } },
  cliStatus: null as unknown,
  cliStatusLoading: false,
  cliProviderStatusByScope: {} as Record<string, CliProviderStatus>,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('@features/codex-account/renderer', () => ({
  useCodexAccountSnapshot: () => ({ loading: false, snapshot: null, error: null }),
  mergeCodexCliStatusWithSnapshot: (cliStatus: unknown) => cliStatus,
  mergeCodexProviderStatusWithSnapshot: (
    providerStatus: CliProviderStatus,
    snapshot: CodexAccountSnapshotDto | null
  ) =>
    snapshot
      ? {
          ...providerStatus,
          authenticated: snapshot.launchAllowed,
          statusMessage: snapshot.launchIssueMessage ?? 'ChatGPT account ready',
          capabilities: {
            ...providerStatus.capabilities,
            teamLaunch: snapshot.launchAllowed,
          },
        }
      : providerStatus,
  isCodexAccountSnapshotPending: () => false,
}));

function status(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'ready',
    statusMessage: null,
    detailMessage: null,
    models: ['opencode/big-pickle'],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: { kind: 'opencode', label: 'OpenCode' },
    connection: null,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'static-fallback',
      status: 'ready',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: 'opencode/big-pickle',
      defaultLaunchModel: 'opencode/big-pickle',
      models: [
        {
          id: 'opencode/big-pickle',
          launchModel: 'opencode/big-pickle',
          displayName: 'Big Pickle',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'static-fallback',
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    subscriptionRateLimits: null,
    ...overrides,
  };
}

describe('resolveProjectScopedProviderStatus', () => {
  it('revokes launch exactly at staleAt while preserving authoritative authentication', () => {
    const scoped = status({
      modelCatalog: {
        ...status().modelCatalog!,
        staleAt: '2026-08-29T00:00:00.100Z',
      },
    });

    expect(
      resolveProjectScopedProviderStatus(
        'opencode',
        scoped,
        null,
        Date.parse('2026-08-29T00:00:00.099Z')
      )?.capabilities.teamLaunch
    ).toBe(true);
    const expired = resolveProjectScopedProviderStatus(
      'opencode',
      scoped,
      null,
      Date.parse('2026-08-29T00:00:00.100Z')
    );
    expect(expired).toMatchObject({
      authenticated: true,
      authMethod: 'builtin_free',
      verificationState: 'verified',
      capabilities: { teamLaunch: false },
    });
  });

  it.each([undefined, 'not-a-date'])('fails closed for a %s staleAt', (staleAt) => {
    const scoped = status({
      modelCatalog: { ...status().modelCatalog!, staleAt: staleAt as string },
    });

    expect(
      resolveProjectScopedProviderStatus('opencode', scoped, null)?.capabilities.teamLaunch
    ).toBe(false);
  });

  it('does not reuse a global catalog before the exact project responds', () => {
    const resolved = resolveProjectScopedProviderStatus('opencode', null, status());

    expect(resolved).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
      models: [],
      modelCatalog: null,
      modelCatalogRefreshState: 'loading',
      capabilities: { teamLaunch: false },
    });
  });

  it('uses an authoritative catalog from the exact project scope', () => {
    const scoped = status({
      models: ['project/provider-model'],
      modelCatalog: {
        ...status().modelCatalog!,
        defaultModelId: 'project/provider-model',
        defaultLaunchModel: 'project/provider-model',
        models: [
          {
            ...status().modelCatalog!.models[0],
            id: 'project/provider-model',
            launchModel: 'project/provider-model',
          },
        ],
      },
    });

    const resolved = resolveProjectScopedProviderStatus('opencode', scoped, status());
    expect(resolved).toEqual(scoped);
    expect(resolved).not.toBe(scoped);
  });

  it('applies the Codex account snapshot to scoped status before launch gating', () => {
    const scoped = status({
      providerId: 'codex',
      authenticated: false,
      capabilities: { ...status().capabilities, teamLaunch: false },
      modelCatalog: {
        ...status().modelCatalog!,
        providerId: 'codex',
        defaultModelId: 'codex/gpt-5.6',
        defaultLaunchModel: 'codex/gpt-5.6',
        models: [
          {
            ...status().modelCatalog!.models[0],
            id: 'codex/gpt-5.6',
            launchModel: 'codex/gpt-5.6',
          },
        ],
      },
    });
    const snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      launchIssueMessage: null,
      launchReadinessState: 'ready_chatgpt',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: { available: false, source: null, sourceLabel: null },
      requiresOpenaiAuth: true,
      login: { status: 'idle', error: null, startedAt: null },
      rateLimits: null,
      updatedAt: '2026-09-03T20:00:00.000Z',
    } as const satisfies CodexAccountSnapshotDto;

    const resolved = resolveProjectScopedProviderStatus(
      'codex',
      scoped,
      null,
      Date.parse('2026-09-03T20:01:00.000Z'),
      snapshot
    );

    expect(resolved).toMatchObject({
      providerId: 'codex',
      authenticated: true,
      statusMessage: 'ChatGPT account ready',
      capabilities: { teamLaunch: true },
    });
  });

  it.each(['pending', 'model_only', 'transient_error'] as const)(
    'revokes %s scoped evidence without borrowing global readiness',
    (statusCheckOutcome) => {
      const scoped = status({
        authenticated: true,
        authMethod: 'unsafe',
        statusCheckOutcome,
        statusCheckErrorCode:
          statusCheckOutcome === 'transient_error' ? 'timeout' : 'partial_response',
        capabilities: { ...status().capabilities, teamLaunch: true },
      });

      const resolved = resolveProjectScopedProviderStatus('opencode', scoped, status());

      expect(resolved).toMatchObject({
        authenticated: false,
        authMethod: null,
        statusCheckOutcome,
        models: ['opencode/big-pickle'],
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });
    }
  );

  it.each(['stale', 'degraded', 'unavailable'] as const)(
    'revokes a scoped %s catalog',
    (catalogStatus) => {
      const base = status();
      const scoped = status({
        modelCatalog: { ...base.modelCatalog!, status: catalogStatus },
      });

      const resolved = resolveProjectScopedProviderStatus('opencode', scoped, base);

      expect(resolved?.authenticated).toBe(true);
      expect(resolved?.capabilities.teamLaunch).toBe(false);
      expect(resolved?.modelCatalog?.status).toBe('stale');
    }
  );

  it('rejects a scoped response for a different provider', () => {
    const resolved = resolveProjectScopedProviderStatus(
      'opencode',
      status({ providerId: 'codex', models: ['gpt-5'], modelCatalog: null }),
      status()
    );

    expect(resolved).toMatchObject({
      providerId: 'opencode',
      authenticated: false,
      models: [],
      modelCatalog: null,
      statusCheckOutcome: 'pending',
      capabilities: { teamLaunch: false },
    });
  });

  it('returns null when neither scoped nor matching global evidence exists', () => {
    expect(resolveProjectScopedProviderStatus('opencode', null, null)).toBeNull();
    expect(
      resolveProjectScopedProviderStatus(
        'opencode',
        status({ providerId: 'codex' }),
        status({ providerId: 'anthropic' })
      )
    ).toBeNull();
  });
});

describe('useEffectiveCliProviderStatus catalog expiry', () => {
  const baseTime = Date.parse('2026-08-29T00:00:00.000Z');
  let renderedLaunchReady: boolean | undefined;

  function Harness({ projectPath }: { projectPath: string }) {
    renderedLaunchReady = useEffectiveCliProviderStatus('opencode', { projectPath }).providerStatus
      ?.capabilities.teamLaunch;
    return null;
  }

  function setProjectCatalog(projectPath: string, staleAt: number) {
    const provider = status({
      modelCatalog: { ...status().modelCatalog!, staleAt: new Date(staleAt).toISOString() },
    });
    storeState.cliStatus = { flavor: 'agent_teams_orchestrator', providers: [provider] };
    storeState.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: provider,
    };
  }

  async function hydrateAuthorityClock() {
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(0));
  }

  afterEach(() => {
    document.body.innerHTML = '';
    storeState.cliStatus = null;
    storeState.cliProviderStatusByScope = {};
    renderedLaunchReady = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('revokes launch authority exactly when staleAt is reached', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    setProjectCatalog('/project', baseTime + 100);
    const root = createRoot(document.createElement('div'));

    await act(async () => root.render(createElement(Harness, { projectPath: '/project' })));
    expect(renderedLaunchReady).toBe(false);
    await hydrateAuthorityClock();
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(renderedLaunchReady).toBe(false);
    await act(async () => root.unmount());
  });

  it('chunks delays above the browser timer maximum and still revokes at the exact boundary', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    setProjectCatalog('/project', baseTime + MAX_BROWSER_TIMEOUT_MS + 100);
    const root = createRoot(document.createElement('div'));

    await act(async () => root.render(createElement(Harness, { projectPath: '/project' })));
    expect(renderedLaunchReady).toBe(false);
    await hydrateAuthorityClock();
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(MAX_BROWSER_TIMEOUT_MS));
    expect(renderedLaunchReady).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(renderedLaunchReady).toBe(false);
    await act(async () => root.unmount());
  });

  it('reschedules when the project catalog changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    setProjectCatalog('/first', baseTime + 100);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness, { projectPath: '/first' })));
    await hydrateAuthorityClock();
    expect(renderedLaunchReady).toBe(true);

    setProjectCatalog('/second', baseTime + 200);
    await act(async () => root.render(createElement(Harness, { projectPath: '/second' })));
    expect(renderedLaunchReady).toBe(false);
    await hydrateAuthorityClock();
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(renderedLaunchReady).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(renderedLaunchReady).toBe(false);
    await act(async () => root.unmount());
  });

  it('cleans up the expiry timer on unmount', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    setProjectCatalog('/project', baseTime + 100);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness, { projectPath: '/project' })));
    await hydrateAuthorityClock();
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
