import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CliStatusSection } from '@renderer/components/settings/sections/CliStatusSection';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import type { CliProviderStatusFetchOptions } from '@renderer/store/slices/cliInstallerSlice';
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';
import type { ComponentProps } from 'react';

type DialogProps = ComponentProps<typeof ProviderRuntimeSettingsDialog>;
const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  fetch: vi.fn(),
  invalidate: vi.fn(),
  dialog: null as DialogProps | null,
}));
vi.mock('@renderer/store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useStore: (selector: (state: Record<string, unknown>) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => selector(mocks.state)
      ),
  };
});
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
vi.mock('@features/codex-account/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/codex-account/renderer')>()),
  useCodexAccountSnapshot: () => ({ loading: false, snapshot: null, error: null }),
  isCodexAccountSnapshotPending: () => false,
}));
vi.mock('@renderer/api', () => ({ isElectronMode: () => true, api: {} }));
vi.mock('@renderer/components/runtime/ProviderRuntimeSettingsDialog', () => ({
  ProviderRuntimeSettingsDialog: (props: DialogProps) => {
    mocks.dialog = props;
    return null;
  },
}));
vi.mock('@renderer/components/runtime/ProviderModelBadges', () => ({
  ProviderModelBadges: ({ models }: { models: string[] }) => (
    <span data-testid="models">{models.join(',')}</span>
  ),
}));
vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({ ProviderBrandLogo: () => null }));
vi.mock('@renderer/components/terminal/TerminalModal', () => ({ TerminalModal: () => null }));
vi.mock('@renderer/components/settings/components', () => ({
  SettingsSectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

function provider(model: string, authenticated = false): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated,
    authMethod: authenticated ? 'api_key' : null,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: null,
    statusMessage: `${model} disconnected`,
    detailMessage: null,
    canLoginFromUi: false,
    capabilities: { teamLaunch: authenticated, oneShot: authenticated, extensions: {} },
    models: [`opencode/${model}`],
    modelAvailability: [],
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'ready',
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date().toISOString(),
      staleAt: new Date(Date.now() + 60000).toISOString(),
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [
        {
          id: `opencode/${model}`,
          launchModel: `opencode/${model}`,
          displayName: model,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          metadata: {
            free: true,
            opencode: {
              providerId: 'opencode',
              modelId: model,
              sourceLabel: 'OpenCode',
              routeKind: 'builtin_free',
              accessKind: 'builtin_free',
              proofState: 'needs_probe',
              requiresExecutionProof: true,
              reason: null,
            },
          },
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  } as unknown as CliProviderStatus;
}
function publish(patch: Record<string, unknown>) {
  mocks.state = { ...mocks.state, ...patch };
  for (const listener of mocks.listeners) listener();
}
function publishScope(projectPath: string, status: CliProviderStatus) {
  publish({
    cliProviderStatusByScope: {
      ...(mocks.state.cliProviderStatusByScope as Record<string, CliProviderStatus>),
      [getCliProviderStatusScopeKey('opencode', projectPath)]: status,
    },
  });
}
let root: Root, host: HTMLDivElement, globalStatus: CliInstallationStatus;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.dialog = null;
  mocks.fetch.mockResolvedValue(false);
  mocks.invalidate.mockResolvedValue(undefined);
  globalStatus = {
    flavor: 'agent_teams_orchestrator',
    installed: true,
    binaryPath: '/TEST/runtime',
    providers: [provider('GLOBAL')],
  } as CliInstallationStatus;
  mocks.state = {
    appConfig: { general: { multimodelEnabled: true } },
    selectedProjectId: 'A',
    projects: [
      { id: 'A', name: 'A', path: '/TEST/A' },
      { id: 'B', name: 'B', path: '/TEST/B' },
    ],
    repositoryGroups: [],
    cliStatus: globalStatus,
    cliStatusLoading: false,
    cliProviderStatusLoading: {},
    cliProviderStatusByScope: {},
    cliProviderStatusScopeRevision: 0,
    cliInstallerState: 'idle',
    cliDownloadProgress: 0,
    cliDownloadTransferred: 0,
    cliDownloadTotal: 0,
    openCodeRuntimeStatus: { installed: true, state: 'ready', version: '1.3.3', source: 'managed' },
    codexRuntimeStatus: null,
    codexRuntimeStatusLoading: false,
    fetchCliProviderStatus: mocks.fetch,
    invalidateCliStatus: mocks.invalidate,
    installCli: vi.fn(),
    updateConfig: vi.fn(),
    openExtensionsTab: vi.fn(),
  };
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Settings OpenCode project status', () => {
  it.each([
    ['native missing', false],
    ['native missing', true],
    ['support required', false],
    ['support required', true],
  ] as const)(
    'shows the settled %s diagnosis with cached project status=%s',
    async (reason, cached) => {
      const message =
        reason === 'native missing'
          ? 'OpenCode native runtime is not installed.'
          : 'OpenCode V2 support must be installed.';
      const unavailable = {
        ...provider('GLOBAL', true),
        supported: false,
        statusMessage: message,
        detailMessage: 'Install the required OpenCode runtime from the dashboard.',
        statusCheckErrorCode: reason === 'native missing' ? 'runtime_missing' : 'unavailable',
      };
      globalStatus = { ...globalStatus, providers: [unavailable as CliProviderStatus] };
      publish({
        cliStatus: globalStatus,
        openCodeRuntimeStatus:
          reason === 'native missing'
            ? { installed: false, source: 'missing', state: 'idle' }
            : {
                installed: true,
                source: 'app-managed',
                state: 'idle',
                version: '2.2.0',
                v2Support: 'required',
                error: message,
              },
      });
      if (cached) publishScope('/TEST/A', provider('A-cached', true));
      await act(async () => root.render(<CliStatusSection />));
      expect(host.textContent).toContain(message);
      expect(host.textContent).not.toContain('providerRuntime.connectionUi.status.checking');
      expect(host.textContent).not.toContain('Connected via');
      expect(host.textContent).not.toContain('opencode/A-cached');
      expect(host.textContent).not.toContain('opencode/GLOBAL');
      expect(mocks.dialog!.providers[0]).toMatchObject({
        authenticated: false,
        authMethod: null,
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: unavailable.statusCheckErrorCode,
        capabilities: { teamLaunch: false, oneShot: false },
        models: [],
        modelAvailability: [],
        modelCatalog: null,
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it('updates the actual V1 connection header, model list and provider dialog from the refreshed project', async () => {
    publishScope('/TEST/A', provider('A-before'));
    await act(async () => root.render(<CliStatusSection />));
    expect(host.textContent).toContain('A-before disconnected');
    expect(host.textContent).not.toContain('GLOBAL');
    expect(mocks.dialog!.providers[0].models).toEqual(['opencode/A-before']);
    mocks.fetch.mockImplementation(
      async (_id: CliProviderId, options: CliProviderStatusFetchOptions) => {
        publishScope(options.projectPath!, provider('A-connected', true));
        return true;
      }
    );
    await act(async () => {
      await mocks.dialog!.onRefreshProvider!('opencode', 'provider_change');
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenLastCalledWith('opencode', {
      checkReason: 'provider_change',
      projectPath: '/TEST/A',
    });
    expect(host.textContent).toContain('Connected via API key');
    expect(host.textContent).toContain('opencode/A-connected');
    expect(host.textContent).not.toContain('A-before');
    expect(mocks.dialog!.providers[0].authenticated).toBe(true);
    expect(mocks.dialog!.projectPath).toBe('/TEST/A');
    expect(globalStatus.providers[0].authenticated).toBe(false);
    expect(globalStatus.providers[0].models).toEqual(['opencode/GLOBAL']);
  });

  it('updates a V2 Test proof in the dialog without advertising a credential or team launch', async () => {
    const status = provider('free');
    status.statusCheckOutcome = 'model_only';
    publishScope('/TEST/A', status);
    publish({
      openCodeRuntimeStatus: {
        installed: true,
        state: 'ready',
        version: '2.2.0',
        source: 'managed',
        v2Support: 'ready',
      },
    });
    await act(async () => root.render(<CliStatusSection />));
    mocks.fetch.mockImplementation(
      async (_id: CliProviderId, options: CliProviderStatusFetchOptions) => {
        const verified = structuredClone(status);
        verified.modelCatalog!.models[0].metadata!.opencode!.proofState = 'verified';
        publishScope(options.projectPath!, verified);
        return true;
      }
    );
    await act(async () => {
      await mocks.dialog!.onRefreshProvider!('opencode', 'provider_change');
    });
    const displayed = mocks.dialog!.providers[0];
    expect(displayed.modelCatalog!.models[0].metadata!.opencode).toMatchObject({
      proofState: 'verified',
      requiresExecutionProof: true,
    });
    expect(displayed.authenticated).toBe(false);
    expect(displayed.capabilities.teamLaunch).toBe(false);
    expect(host.textContent).not.toContain('Connected via');
    expect(host.textContent).not.toContain('GLOBAL');
  });

  it('masks unknown project B and ignores a late update for project A', async () => {
    publishScope('/TEST/A', provider('A-connected', true));
    await act(async () => root.render(<CliStatusSection />));
    expect(host.textContent).toContain('Connected via API key');
    await act(async () => publish({ selectedProjectId: 'B' }));
    expect(host.textContent).toContain('providerRuntime.connectionUi.status.checking');
    expect(mocks.dialog!.providers[0].statusMessage).toBe('Checking...');
    expect(host.textContent).not.toContain('Connected via');
    expect(host.textContent).not.toContain('opencode/A-connected');
    expect(host.textContent).not.toContain('GLOBAL');
    expect(mocks.dialog!.providers[0].modelCatalog).toBeNull();
    expect(mocks.dialog!.projectPath).toBe('/TEST/B');
    await act(async () => publishScope('/TEST/A', provider('A-late', true)));
    expect(host.textContent).not.toContain('A-late');
    expect(mocks.dialog!.providers[0].authenticated).toBe(false);
    await act(async () => publishScope('/TEST/B', provider('B-ready', true)));
    expect(host.textContent).toContain('opencode/B-ready');
    expect(mocks.dialog!.providers[0].models).toEqual(['opencode/B-ready']);
  });

  it('keeps the global header and unscoped refresh when no project is selected', async () => {
    publishScope('/TEST/A', provider('A-connected', true));
    publish({ selectedProjectId: null });
    await act(async () => root.render(<CliStatusSection />));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('GLOBAL disconnected');
    expect(host.textContent).not.toContain('A-connected');
    expect(mocks.dialog!.providers[0]).toBe(globalStatus.providers[0]);
    await act(async () => {
      await mocks.dialog!.onRefreshProvider!('opencode');
    });
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('opencode', {
      checkReason: 'manual_refresh',
      projectPath: null,
    });
  });
});
