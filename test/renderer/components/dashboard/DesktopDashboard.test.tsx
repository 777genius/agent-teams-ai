import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  openTeamsTab: vi.fn(),
  openCommandPalette: vi.fn(),
  selectedProjectId: null as string | null,
  activeContextId: 'local',
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));
vi.mock('@renderer/utils/stringUtils', () => ({ formatShortcut: () => 'Ctrl K' }));
vi.mock('@features/recent-projects/renderer', () => ({
  RecentProjectsSection: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="desktop-recent">
      {['Alpha project', 'Beta project']
        .filter((name) => name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
        .map((name) => <p key={name}>{name}</p>)}
    </div>
  ),
}));
vi.mock('@features/running-teams/renderer', () => ({
  useDesktopRunningTeams: () => ({
    title: 'Running teams',
    rows: [
      { targetKey: 'alpha', displayName: 'Alpha team', status: 'active', statusLabel: 'Active' },
      { targetKey: 'beta', displayName: 'Beta team', status: 'idle', statusLabel: 'Running' },
    ],
    onOpen: vi.fn(),
  }),
}));
vi.mock('@renderer/components/dashboard/CliStatusBanner', () => ({ CliStatusBanner: () => <div>CLI notice</div> }));
vi.mock('@renderer/components/dashboard/DashboardUpdateBanner', () => ({ DashboardUpdateBanner: () => null }));
vi.mock('@renderer/components/dashboard/TmuxStatusBanner', () => ({ TmuxStatusBanner: () => null }));
vi.mock('@renderer/components/dashboard/WebPreviewBanner', () => ({ WebPreviewBanner: () => null }));
vi.mock('@renderer/components/dashboard/WindowsAdministratorBanner', () => ({ WindowsAdministratorBanner: () => null }));

import { DashboardView } from '@renderer/components/dashboard/DashboardView';
import { TooltipProvider } from '@renderer/components/ui/tooltip';

describe('Desktop Dashboard composition', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps Desktop notices and filters both Desktop collections through shared search', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<TooltipProvider><DashboardView /></TooltipProvider>));
    expect(host.textContent).toContain('CLI notice');
    expect(host.textContent).toContain('Beta team');
    expect(host.textContent).toContain('Beta project');

    const input = host.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('Alpha team');
    expect(host.textContent).toContain('Alpha project');
    expect(host.textContent).not.toContain('Beta team');
    expect(host.textContent).not.toContain('Beta project');
    act(() => root.unmount());
  });

  it('does not capture Cmd/Ctrl+K or focus when the Desktop Dashboard is hidden', () => {
    state.openCommandPalette.mockReset();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<TooltipProvider><DashboardView isActive={false} /></TooltipProvider>));
    expect(document.activeElement).toBe(other);
    act(() => other.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true,
    })));
    expect(state.openCommandPalette).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('focuses search on an active Dashboard without an overlay', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<TooltipProvider><DashboardView isActive /></TooltipProvider>));
    expect(document.activeElement).toBe(host.querySelector('input'));
    act(() => root.unmount());
  });
});
