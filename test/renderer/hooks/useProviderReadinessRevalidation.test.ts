import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useProviderReadinessRevalidation } from '@renderer/hooks/useProviderReadinessRevalidation';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

const state = {
  fetchCliProviderStatus: vi.fn().mockResolvedValue(false),
  cliProviderStatusLoading: {} as Partial<Record<CliProviderId, boolean>>,
  cliStatusLoading: false,
  bootstrapCliStatus: vi.fn().mockResolvedValue(undefined),
  fetchCliStatus: vi.fn().mockResolvedValue(undefined),
  appConfig: { general: { multimodelEnabled: true } },
};
vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

function catalogProvider(providerId: CliProviderId, expiry: number): CliProviderStatus {
  const base = createLoadingMultimodelCliStatus().providers.find(
    (p) => p.providerId === providerId
  )!;
  return {
    ...base,
    authenticated: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
    modelCatalogRefreshState: 'ready',
    capabilities: { ...base.capabilities, teamLaunch: true },
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      staleAt: new Date(expiry).toISOString(),
      defaultModelId: 'model',
      defaultLaunchModel: 'model',
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: [
        {
          id: 'model',
          launchModel: 'model',
          displayName: 'Model',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
    },
  };
}

describe('selected provider readiness revalidation', () => {
  let root: ReturnType<typeof createRoot>;
  let status: CliInstallationStatus;
  let enabled: boolean;
  let selected: CliProviderId[];
  function Probe() {
    useProviderReadinessRevalidation(enabled, selected, status);
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(createElement(Probe));
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    state.cliProviderStatusLoading = {};
    state.cliStatusLoading = false;
    status = {
      ...createLoadingMultimodelCliStatus(),
      installed: true,
      providers: [
        catalogProvider('codex', Date.now() + 1000),
        catalogProvider('anthropic', Date.now() + 5000),
      ],
    };
    enabled = true;
    selected = ['codex'];
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes at the exact expiry despite unrelated provider polling', async () => {
    await render();
    await act(async () => vi.advanceTimersByTime(500));
    status = { ...status, providers: [...status.providers] };
    await render();
    await act(async () => vi.advanceTimersByTime(500));
    expect(state.fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith('codex');
    await act(async () => vi.advanceTimersByTime(60_000));
    status = { ...status };
    await render();
    expect(state.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'missing', 'expired'] as const)(
    'refreshes %s evidence once on open and allows reopening',
    async (kind) => {
      const provider = catalogProvider('codex', Date.now() - 1);
      if (kind === 'error') provider.modelCatalogRefreshState = 'error';
      if (kind === 'missing') provider.modelCatalog = null;
      status = { ...status, providers: [provider] };
      await render();
      status = { ...status };
      await render();
      expect(state.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
      enabled = false;
      await render();
      enabled = true;
      await render();
      expect(state.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    }
  );

  it('does not duplicate loading catalogs and retries only after loading settles', async () => {
    status.providers[0]!.modelCatalogRefreshState = 'loading';
    await render();
    expect(state.fetchCliProviderStatus).not.toHaveBeenCalled();
    status = {
      ...status,
      providers: [{ ...status.providers[0]!, modelCatalogRefreshState: 'error' }],
    };
    await render();
    expect(state.fetchCliProviderStatus).toHaveBeenCalledTimes(1);
  });

  it('re-arms after genuinely fresh evidence without refreshing another provider', async () => {
    status.providers[0] = catalogProvider('codex', Date.now() - 1);
    await render();
    status = { ...status, providers: [catalogProvider('codex', Date.now() + 500)] };
    await render();
    await act(async () => vi.advanceTimersByTime(500));
    expect(state.fetchCliProviderStatus).toHaveBeenCalledTimes(2);
    expect(state.fetchCliProviderStatus.mock.calls.every(([id]) => id === 'codex')).toBe(true);
  });
});
