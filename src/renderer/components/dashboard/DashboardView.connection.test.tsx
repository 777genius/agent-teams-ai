import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from './DashboardView';

const state = vi.hoisted(() => ({
  openSettingsTab: vi.fn(),
  openTeamsTab: vi.fn(),
  openCommandPalette: vi.fn(),
  selectedProjectId: null,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ isElectronMode: () => true }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@features/recent-projects/renderer', () => ({ RecentProjectsSection: () => null }));
vi.mock('@features/running-teams/renderer', () => ({ RunningTeamsSection: () => null }));
vi.mock('./DashboardProviderSummary', () => ({
  DashboardProviderSummary: () => <div data-testid="providers" />,
}));
vi.mock('./DashboardUpdateBanner', () => ({ DashboardUpdateBanner: () => null }));
vi.mock('./TmuxStatusBanner', () => ({ TmuxStatusBanner: () => null }));
vi.mock('./WebPreviewBanner', () => ({ WebPreviewBanner: () => null }));
vi.mock('./WindowsAdministratorBanner', () => ({ WindowsAdministratorBanner: () => null }));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('dashboard agent connection', () => {
  it('places the connection action before providers and opens its settings', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DashboardView />));
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="dashboard-connect-ai-agent"]'
    );
    const providers = host.querySelector('[data-testid="providers"]');
    expect(button).not.toBeNull();
    expect(providers).not.toBeNull();
    expect(
      button!.compareDocumentPosition(providers!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await act(async () => button!.click());
    expect(state.openSettingsTab).toHaveBeenCalledWith('externalAgentConnection');
    await act(async () => root.unmount());
  });
});
