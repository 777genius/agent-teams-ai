import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardProviderSummary } from './DashboardProviderSummary';

const state = vi.hoisted(() => ({
  cliStatus: null as null | object,
  cliStatusLoading: false,
  cliStatusError: null,
  cliProviderStatusLoading: {},
  openCodeRuntimeStatus: null as null | {
    installed: boolean;
    state: string;
    version: string;
    binaryPath: string;
  },
  openCodeRuntimeStatusLoading: false,
  countEvidence: null as null | { checking: boolean; observation: null; invalidated: boolean },
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
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/runtime-provider-management/renderer', () => ({
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
    state.cliProviderStatusLoading = {};
    state.countEvidence = null;
    state.openCodeRuntimeStatus = null;
    state.appConfig.general.multimodelEnabled = true;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows unknown status and opens Providers without starting IPC work', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(DashboardProviderSummary)));
      expect(host.querySelector('[data-testid="dashboard-provider-summary"]')).not.toBeNull();
      expect(
        host.querySelector('[data-testid="dashboard-main-provider-count"]')?.textContent
      ).toContain('runtimeProvider.badges.unknown');
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
