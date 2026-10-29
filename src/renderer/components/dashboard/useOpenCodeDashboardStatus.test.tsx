import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useOpenCodeConnectedModelCatalog } from '@features/runtime-provider-management/renderer';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasAvailableFreeOpenCodeDashboardModel } from './openCodeDashboardCatalogPolicy';
import {
  useDashboardProviderRefresh,
  useOpenCodeDashboardStatus,
} from './useOpenCodeDashboardStatus';

import type { CliProviderStatusFetchOptions } from '@renderer/store/slices/cliInstallerSlice';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types';

const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  fetch: vi.fn(),
  directory: vi.fn(),
  models: vi.fn(),
  refreshDirectory: vi.fn(),
  refreshAnthropic: vi.fn(),
}));
vi.mock('@renderer/store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useStore: (selector: (snapshot: Record<string, unknown>) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => selector(mocks.snapshot)
      ),
  };
});
vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    runtimeProviderManagement: {
      loadProviderDirectory: (...args: unknown[]) => mocks.directory(...args),
      loadModels: (...args: unknown[]) => mocks.models(...args),
      cancelModelLoad: vi.fn(async () => undefined),
    },
  },
}));

const runtime = {
  installed: true,
  state: 'ready',
  source: 'app-managed',
  version: '2.2.0',
  v2Support: 'ready',
} as OpenCodeRuntimeStatus;
function provider(verified: boolean): CliProviderStatus {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    statusCheckErrorCode: null,
    capabilities: { teamLaunch: false, oneShot: false },
    models: ['opencode/big-pickle'],
    modelAvailability: [],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'stale',
      fetchedAt: new Date(0).toISOString(),
      staleAt: new Date(0).toISOString(),
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [
        {
          id: 'opencode/big-pickle',
          launchModel: 'opencode/big-pickle',
          displayName: 'Big Pickle',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          metadata: {
            free: true,
            opencode: {
              providerId: 'opencode',
              modelId: 'big-pickle',
              routeKind: 'builtin_free',
              accessKind: verified ? 'verified' : 'builtin_free',
              proofState: verified ? 'verified' : 'needs_probe',
              requiresExecutionProof: true,
            },
          },
        },
      ],
    },
  } as unknown as CliProviderStatus;
}
let root: Root;
let globalStatus: CliInstallationStatus;
let observed: {
  status: ReturnType<typeof useOpenCodeDashboardStatus>;
  catalog: ReturnType<typeof useOpenCodeConnectedModelCatalog>;
  refresh: ReturnType<typeof useDashboardProviderRefresh>;
};
const Probe = ({
  projectPath = '/sandbox/a',
  enabled = true,
}: {
  projectPath?: string | null;
  enabled?: boolean;
}) => {
  const status = useOpenCodeDashboardStatus({
    enabled,
    projectPath,
    cliStatus: globalStatus,
    runtimeStatus: runtime,
  });
  const catalog = useOpenCodeConnectedModelCatalog({
    enabled: status.enabled,
    projectPath,
    passiveProviderStatus: status.providerStatus,
  });
  const refresh = useDashboardProviderRefresh(
    projectPath,
    mocks.refreshDirectory,
    mocks.refreshAnthropic
  );
  observed = { status, catalog, refresh };
  return (
    <span>
      {catalog.providerStatus &&
      hasAvailableFreeOpenCodeDashboardModel(catalog.providerStatus, runtime)
        ? 'Free models'
        : 'Needs test'}
    </span>
  );
};
function publishScope(projectPath: string, status: CliProviderStatus) {
  mocks.snapshot = {
    ...mocks.snapshot,
    cliProviderStatusByScope: {
      ...(mocks.snapshot.cliProviderStatusByScope as Record<string, CliProviderStatus>),
      [getCliProviderStatusScopeKey('opencode', projectPath)]: status,
    },
  };
  for (const listener of mocks.listeners) listener();
}
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(false);
  mocks.snapshot = {
    fetchCliProviderStatus: mocks.fetch,
    cliProviderStatusByScope: {},
    cliProviderStatusScopeRevision: 0,
  };
  globalStatus = {
    flavor: 'agent_teams_orchestrator',
    providers: [provider(false)],
  } as CliInstallationStatus;
  mocks.directory.mockResolvedValue({
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries: [{ providerId: 'opencode', state: 'available-readonly', metadata: {} }],
      totalCount: 1,
      returnedCount: 1,
      cursor: null,
      nextCursor: null,
    },
  });
  mocks.models.mockResolvedValue({
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: 'opencode',
      catalogState: 'fresh',
      defaultModelId: null,
      models: [
        {
          providerId: 'opencode',
          modelId: 'big-pickle',
          displayName: 'Big Pickle',
          sourceLabel: 'OpenCode',
          default: false,
          free: true,
          availability: 'available',
          accessKind: 'builtin_free',
        },
      ],
    },
  });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('selected-project dashboard proof', () => {
  it('refreshes the tested project and shows its free badge without changing global status or launch authority', async () => {
    await act(async () => root.render(<Probe />));
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/sandbox/a',
    });
    expect(container.textContent).toBe('Needs test');
    mocks.fetch.mockImplementation(
      async (_provider: CliProviderId, options: CliProviderStatusFetchOptions) => {
        publishScope(options.projectPath!, provider(true));
        return true;
      }
    );
    await act(async () => {
      await observed.refresh('opencode', 'provider_change');
    });
    expect(mocks.fetch).toHaveBeenLastCalledWith('opencode', {
      checkReason: 'provider_change',
      projectPath: '/sandbox/a',
    });
    expect(mocks.refreshDirectory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('Free models');
    expect(observed.catalog.providerStatus?.modelCatalog?.status).toBe('degraded');
    expect(observed.catalog.providerStatus?.capabilities.teamLaunch).toBe(false);
    expect(observed.catalog.providerStatus?.authenticated).toBe(false);
    expect(
      observed.catalog.providerStatus?.modelCatalog?.models[0].metadata?.opencode
        ?.requiresExecutionProof
    ).toBe(true);
    expect(globalStatus.providers[0].modelCatalog?.models[0].metadata?.opencode?.proofState).toBe(
      'needs_probe'
    );
  });

  it('never borrows a global or another project proof while entering a project', async () => {
    globalStatus = { ...globalStatus, providers: [provider(true)] };
    publishScope('/sandbox/a', provider(true));
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe('Free models');
    await act(async () => root.render(<Probe projectPath="/sandbox/b" />));
    expect(container.textContent).toBe('Needs test');
    expect(observed.status.providerStatus?.modelCatalog).toBeNull();
    expect(
      observed.catalog.providerStatus?.modelCatalog?.models[0].metadata?.opencode?.proofState
    ).toBe('needs_probe');
    expect(mocks.fetch).toHaveBeenLastCalledWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath: '/sandbox/b',
    });
  });

  it('keeps a late project A refresh confined to A after switching the dashboard to B', async () => {
    await act(async () => root.render(<Probe />));
    let complete!: () => void;
    mocks.fetch.mockImplementation(
      (_provider: CliProviderId, options: CliProviderStatusFetchOptions) =>
        options.projectPath === '/sandbox/a'
          ? new Promise<boolean>((resolve) => {
              complete = () => {
                publishScope('/sandbox/a', provider(true));
                resolve(true);
              };
            })
          : Promise.resolve(false)
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = observed.refresh('opencode', 'provider_change');
    });
    await act(async () => root.render(<Probe projectPath="/sandbox/b" />));
    await act(async () => {
      complete();
      await pending;
    });
    expect(container.textContent).toBe('Needs test');
    expect(observed.status.providerStatus?.modelCatalog).toBeNull();
    mocks.fetch.mockResolvedValue(false);
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe('Free models');
  });

  it('keeps the unscoped dashboard unscoped when there is no selected project', async () => {
    globalStatus = { ...globalStatus, providers: [provider(true)] };
    await act(async () => root.render(<Probe projectPath={null} />));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Free models');
    await act(async () => {
      await observed.refresh('opencode');
    });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('opencode', {
      checkReason: 'manual_refresh',
    });
  });

  it('does not loop on V2 catalog-only expiry or unchanged scoped status', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => publishScope('/sandbox/a', provider(false)));
    await act(async () => publishScope('/sandbox/a', provider(false)));
    await act(async () => root.render(<Probe />));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves non-OpenCode refresh scope and only advances Anthropic rate limits on success', async () => {
    await act(async () => root.render(<Probe enabled={false} />));
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(true);
    await act(async () => {
      await observed.refresh('anthropic');
    });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('anthropic', {
      checkReason: 'manual_refresh',
    });
    expect(mocks.refreshDirectory).not.toHaveBeenCalled();
    expect(mocks.refreshAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAnthropic.mock.calls[0][0](4)).toBe(5);
  });

  it('refreshes the directory after a rejected scoped status without hiding the failure', async () => {
    await act(async () => root.render(<Probe enabled={false} />));
    mocks.fetch.mockRejectedValue(new Error('status unavailable'));
    await expect(observed.refresh('opencode')).rejects.toThrow('status unavailable');
    expect(mocks.refreshDirectory).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAnthropic).not.toHaveBeenCalled();
  });
});
