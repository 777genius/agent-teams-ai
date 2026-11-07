import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardProviderSummary } from './DashboardProviderSummary';

const state = vi.hoisted(() => ({
  cliStatus: null as null | object,
  cliStatusLoading: false,
  cliStatusError: null,
  cliProviderStatusLoading: {},
  openCodeRuntimeStatus: null,
  openSettingsTab: vi.fn(),
  selectedProjectId: null,
  projects: [],
  repositoryGroups: [],
  appConfig: { general: { multimodelEnabled: true } },
  directoryReads: vi.fn(),
  getStatus: vi.fn(),
  loadProviderDirectory: vi.fn(),
  loadModels: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/runtime-provider-management/renderer', () => ({
  useRuntimeProviderDirectoryCache: () => state.directoryReads() ?? null,
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
vi.mock('@renderer/store', () => ({
  useStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

describe('DashboardProviderSummary (passive)', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
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
      expect(host.querySelector('[data-testid="dashboard-main-provider-count"]')?.textContent)
        .toContain('runtimeProvider.badges.unknown');
      expect(state.getStatus).not.toHaveBeenCalled();
      expect(state.loadProviderDirectory).not.toHaveBeenCalled();
      expect(state.loadModels).not.toHaveBeenCalled();
      const button = host.querySelector<HTMLButtonElement>('[data-testid="dashboard-manage-providers"]');
      await act(async () => button?.click());
      expect(state.openSettingsTab).toHaveBeenCalledExactlyOnceWith('providers');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
