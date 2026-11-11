import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardProviderSummary } from './DashboardProviderSummary';

const state = vi.hoisted(() => ({
  cliStatus: null as null | object,
  cliStatusLoading: false,
  cliStatusError: null,
  cliProviderStatusLoading: {},
  codexStatusRecoveryPending: false,
  openCodeRuntimeStatus: null as null | {
    installed: boolean;
    state: string;
    version: string;
    binaryPath: string;
  },
  openCodeRuntimeStatusLoading: false,
  openCodeRuntimeError: null as string | null,
  countEvidence: null as null | {
    checking: boolean;
    observation: null | {
      connected: number;
      fetchedAt: string;
      runtimeRevision: string;
      source: 'summary-connected';
    };
    invalidated: boolean;
  },
  openSettingsTab: vi.fn(),
  openTab: vi.fn(),
  selectedProjectId: null,
  projects: [],
  repositoryGroups: [],
  appConfig: { general: { multimodelEnabled: true } },
  directoryReads: vi.fn(),
  getStatus: vi.fn(),
  loadProviderDirectory: vi.fn(),
  loadModels: vi.fn(),
  connectedCountProbe: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: { connected?: number }) =>
      values?.connected === undefined ? key : `${key} ${values.connected}`,
  }),
}));
vi.mock('@features/runtime-provider-management/renderer', () => ({
  isOpenCodeRuntimeUsable: (runtime: typeof state.openCodeRuntimeStatus) =>
    runtime?.installed === true,
  useRuntimeProviderDirectoryCache: () => state.directoryReads() ?? null,
  useRuntimeProviderConnectedCount: () => state.countEvidence,
  useOpenCodeDashboardConnectedCountProbe: state.connectedCountProbe,
}));
vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: {
    cliInstaller: { getStatus: state.getStatus },
    runtimeProviderManagement: {
      loadProviderDirectory: state.loadProviderDirectory,
      loadModels: state.loadModels,
    },
  },
}));
vi.mock('@renderer/utils/providerReadiness', () => ({
  hasEffectiveProviderLaunchAuthority: (provider: {
    providerId: string;
    modelCatalog?: { staleAt: string };
  }) =>
    provider.providerId === 'gemini' ||
    (provider.modelCatalog !== undefined && Date.parse(provider.modelCatalog.staleAt) > Date.now()),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

describe('DashboardProviderSummary (passive)', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    state.cliStatus = null;
    state.cliStatusLoading = false;
    state.openCodeRuntimeStatusLoading = false;
    state.openCodeRuntimeError = null;
    state.cliProviderStatusLoading = {};
    state.codexStatusRecoveryPending = false;
    state.countEvidence = null;
    state.openCodeRuntimeStatus = null;
    state.appConfig.general.multimodelEnabled = true;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows startup checking and opens Providers without starting IPC work', async () => {
    state.cliStatusLoading = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-provider-summary"]')).not.toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-codex-status"] [role="status"]')
      ).not.toBeNull();
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent
      ).not.toContain('runtimeProvider.badges.unknown');
      state.cliStatus = {
        installed: true,
        flavor: 'agent_teams_orchestrator',
        providers: [],
      };
      state.cliStatusLoading = false;
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      state.openCodeRuntimeStatusLoading = true;
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      state.openCodeRuntimeStatusLoading = false;
      state.openCodeRuntimeStatus = {
        installed: true,
        state: 'ready',
        version: '1.2.3',
        binaryPath: '/test/opencode',
      };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
      expect(state.getStatus).not.toHaveBeenCalled();
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
      const button = host.querySelector<HTMLButtonElement>(
        '[data-testid="dashboard-manage-providers"]'
      );
      await act(async () => button?.click());
      expect(state.openSettingsTab).toHaveBeenCalledExactlyOnceWith('providers');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps Codex checking while account recovery is pending without changing RPC flags', async () => {
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'codex',
          authenticated: false,
          verificationState: 'unknown',
          statusCheckOutcome: 'authoritative',
        },
      ],
    };
    state.codexStatusRecoveryPending = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      const codex = host.querySelector('[data-testid="dashboard-codex-status"]');
      expect(codex?.querySelector('[role="status"]')).not.toBeNull();
      expect(codex?.textContent).not.toContain('runtimeProvider.badges.unknown');
      expect(state.cliProviderStatusLoading).toEqual({});
      state.codexStatusRecoveryPending = false;
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(codex?.querySelector('[role="status"]')).toBeNull();
      expect(codex?.textContent).toContain('runtimeProvider.badges.unknown');
    } finally {
      await act(async () => root.unmount());
    }
  });
  it('shows expired count 11 beside an actual recheck spinner until fresh count 9 replaces it', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-10T16:00:00Z');
    vi.setSystemTime(now);
    state.openCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      version: '1.2.3',
      binaryPath: '/test/opencode',
    };
    state.countEvidence = {
      checking: true,
      invalidated: false,
      observation: {
        connected: 11,
        fetchedAt: new Date(now - 121_000).toISOString(),
        runtimeRevision: JSON.stringify(['ready', '1.2.3', '/test/opencode']),
        source: 'summary-connected',
      },
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      const count = host.querySelector('[data-testid="dashboard-opencode-provider-count"]');
      expect(count?.textContent).toContain('cliStatus.provider.connectedCount 11');
      expect(count?.textContent).not.toContain('runtimeProvider.badges.unknown');
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      // A hung recheck cannot keep a stale number indefinitely.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(count?.textContent).not.toContain('connectedCount 11');
      state.countEvidence = {
        checking: false,
        invalidated: false,
        observation: {
          ...state.countEvidence.observation!,
          connected: 9,
          fetchedAt: new Date().toISOString(),
        },
      };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(count?.textContent).toContain('cliStatus.provider.connectedCount 9');
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it('keeps a fresh known count visible alongside the loader until remaining checks settle', async () => {
    state.openCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      version: '1.2.3',
      binaryPath: '/test/opencode',
    };
    state.directoryReads.mockReturnValue({
      entries: [{ providerId: 'openrouter', state: 'connected' }],
      authoritative: false,
      fetchedAt: new Date().toISOString(),
      totalCount: 101,
      nextCursor: '100',
      runtimeRevision: JSON.stringify(['ready', '1.2.3', '/test/opencode']),
    });
    state.countEvidence = { checking: true, observation: null, invalidated: false };
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      const count = host.querySelector('[data-testid="dashboard-opencode-provider-count"]');
      expect(count?.textContent).toContain('cliStatus.provider.connectedCount');
      expect(count?.textContent).not.toContain('runtimeProvider.badges.unknown');
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      state.countEvidence = { ...state.countEvidence, checking: false };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(count?.textContent).toContain('cliStatus.provider.connectedCount');
      expect(count?.textContent).toContain('runtimeProvider.badges.unknown');
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
      state.directoryReads.mockReturnValue({
        entries: [{ providerId: 'openrouter', state: 'connected' }],
        authoritative: true,
        fetchedAt: new Date().toISOString(),
        totalCount: 1,
        nextCursor: null,
        runtimeRevision: JSON.stringify(['ready', '1.2.3', '/test/opencode']),
      });
      state.countEvidence = { ...state.countEvidence, checking: true };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(count?.textContent).toContain('cliStatus.provider.connectedCount');
      expect(count?.textContent).not.toContain('runtimeProvider.badges.unknown');
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      state.directoryReads.mockReset();
    }
  });

  it('shows a small OpenCode loader only while a real status or directory check is pending', async () => {
    state.openCodeRuntimeStatusLoading = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent
      ).not.toContain('runtimeProvider.badges.unknown');
      state.openCodeRuntimeStatusLoading = false;
      state.countEvidence = { checking: true, observation: null, invalidated: false };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      state.countEvidence = { checking: false, observation: null, invalidated: false };
      state.openCodeRuntimeError = 'Runtime status lookup failed';
      state.cliStatus = {
        installed: true,
        flavor: 'agent_teams_orchestrator',
        providers: [],
      };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent
      ).toContain('runtimeProvider.badges.unknown');
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('covers ready-runtime count discovery before effects, then settles a failed probe to Unknown', async () => {
    state.cliStatus = { installed: true, flavor: 'agent_teams_orchestrator', providers: [] };
    state.openCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      version: '1.18.31',
      binaryPath: '/test/opencode',
    };
    // No effects run during this render: the count probe cannot publish checking yet.
    const initial = document.createElement('div');
    initial.innerHTML = renderToStaticMarkup(React.createElement(DashboardProviderSummary));
    expect(
      initial.querySelector('[data-testid="dashboard-opencode-count-loading"]')
    ).not.toBeNull();
    expect(
      initial.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent
    ).not.toContain('runtimeProvider.badges.unknown');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      state.countEvidence = { checking: true, observation: null, invalidated: false };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      // Failed empty probes remove their cache entry. Aggregate loading must not
      // keep either the initial pending state or a stale checking signal alive.
      state.countEvidence = null;
      state.cliStatusLoading = true;
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent
      ).toContain('runtimeProvider.badges.unknown');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('shows each main provider independently while its status is checked', async () => {
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          authenticated: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
        },
        {
          providerId: 'codex',
          authenticated: false,
          verificationState: 'unknown',
          statusCheckOutcome: 'pending',
        },
      ],
    };
    state.cliProviderStatusLoading = { codex: true };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-anthropic-status"]')?.className).toContain(
        'text-green-400'
      );
      expect(
        host.querySelector('[data-testid="dashboard-codex-status"] [role="status"]')
      ).not.toBeNull();
      state.cliProviderStatusLoading = {};
      state.cliStatus = {
        installed: true,
        flavor: 'agent_teams_orchestrator',
        providers: [
          {
            providerId: 'anthropic',
            authenticated: true,
            verificationState: 'verified',
            statusCheckOutcome: 'authoritative',
          },
          {
            providerId: 'codex',
            authenticated: true,
            verificationState: 'verified',
            statusCheckOutcome: 'authoritative',
          },
        ],
      };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-codex-status"]')?.className).toContain(
        'text-green-400'
      );
      expect(
        host.querySelector('[data-testid="dashboard-codex-status"] [role="status"]')
      ).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('ignores stale aggregate pending once individual checking has settled', async () => {
    state.cliStatusLoading = true;
    state.openCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      version: '1.2.3',
      binaryPath: '/test/opencode',
    };
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authenticated: false,
          verificationState: 'unknown',
          statusCheckOutcome: 'pending',
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
      state.cliProviderStatusLoading = { opencode: true };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).not.toBeNull();
      state.cliProviderStatusLoading = { opencode: false };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-opencode-count-loading"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('starts only a count probe on an active installed Dashboard and pauses it when hidden', async () => {
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [],
    };
    state.openCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      version: '1.18.31',
      binaryPath: '/test/opencode',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(React.createElement(DashboardProviderSummary, { isActive: false }))
      );
      expect(state.connectedCountProbe).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: false,
          connectedCount: null,
        })
      );
      await act(async () =>
        root.render(React.createElement(DashboardProviderSummary, { isActive: true }))
      );
      expect(state.connectedCountProbe).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          connectedCount: null,
        })
      );
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('reports a missing CLI instead of endlessly checking after discovery settles', async () => {
    state.cliStatus = { installed: false, flavor: 'agent_teams_orchestrator', providers: [] };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(
        host.querySelector('[data-testid="dashboard-main-provider-count"]')?.textContent
      ).toContain('cliStatus.quickConnect.cliNotInstalled');
      expect(state.getStatus).not.toHaveBeenCalled();
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('does not report readiness from a frozen Gemini-only provider', async () => {
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'gemini',
          authenticated: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.textContent).not.toContain('cliStatus.provider.readyToRunAgents');
      expect(host.textContent).toContain('runtimeProvider.tabs.providers');
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('expires the ready heading when model evidence expires without background IPC', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-08T13:00:00Z');
    vi.setSystemTime(now);
    state.cliStatus = {
      installed: true,
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'anthropic',
          authenticated: true,
          modelCatalog: { staleAt: new Date(now + 1000).toISOString() },
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.textContent).toContain('cliStatus.provider.readyToRunAgents');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1015);
      });
      expect(host.textContent).not.toContain('cliStatus.provider.readyToRunAgents');
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it('keeps direct-Claude auth checking ahead of an old authenticated snapshot', async () => {
    state.appConfig.general.multimodelEnabled = false;
    state.cliStatus = {
      installed: true,
      flavor: 'claude',
      providers: [],
      authLoggedIn: true,
      authStatusChecking: true,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.textContent).toContain('cliStatus.provider.checkingAuthentication');
      expect(host.textContent).not.toContain('cliStatus.provider.authenticated');
      state.cliStatus = { ...state.cliStatus, authStatusChecking: false };
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.textContent).toContain('cliStatus.provider.authenticated');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
