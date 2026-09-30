import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DashboardScreen } from '@features/dashboard/renderer';
import {
  RecentProjectsSectionView,
  type RecentProjectCardModel,
  type RecentProjectsCollectionSource,
} from '@features/recent-projects/renderer/browser';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const labels = {
  selectTeam: 'Select team',
  or: 'or',
  searchPlaceholder: 'Search projects',
  palette: 'Open palette',
  paletteShortcut: 'Ctrl K',
  recentTitle: 'Recent projects',
  searchResults: 'Search results',
  clearSearch: 'Clear search',
  noRunningMatches: 'No matching running teams',
};

const recentRows: RecentProjectCardModel[] = ['Alpha project', 'Beta project'].map((name) => ({
  identity: { scopeKey: 'fixture', targetKey: name, readEpoch: 1 },
  name,
  activity: { kind: 'unknown', reason: 'not_provided' },
  providers: { kind: 'unknown', reason: 'not_provided' },
  branch: { kind: 'unknown', reason: 'not_provided' },
  taskCounts: { kind: 'unknown', reason: 'not_provided' },
  tasksLoading: false,
  activeTeams: { kind: 'unknown', reason: 'not_provided' },
  open: { support: 'supported', availability: 'available' },
  reveal: { support: 'unsupported', reason: 'native_only' },
}));
const recentSource: RecentProjectsCollectionSource = {
  scopeKey: 'fixture',
  readEpoch: 1,
  rows: recentRows,
  completeness: 'complete',
  stale: false,
  openProject: async () => ({ kind: 'opened' }),
};

const RecentProjects = ({ searchQuery }: { searchQuery: string }): React.JSX.Element => (
  <RecentProjectsSectionView
    source={recentSource}
    searchQuery={searchQuery}
    loading={false}
    error={null}
    reload={async () => undefined}
  />
);

describe('DashboardScreen', () => {
  let host: HTMLDivElement;
  let root: Root;
  const openPalette = vi.fn();
  const openTeam = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    openPalette.mockReset();
    openTeam.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function render(scopeKey = 'local'): void {
    act(() => root.render(
      <TooltipProvider>
        <DashboardScreen
          scopeKey={scopeKey}
          labels={labels}
          onOpenPalette={openPalette}
          onSelectTeam={openTeam}
          RecentProjects={RecentProjects}
          runningTeams={{
            title: 'Running teams',
            rows: [
              {
                targetKey: 'alpha', displayName: 'Alpha team', projectLabel: 'Alpha project',
                status: 'active', statusLabel: 'Active',
              },
              {
                targetKey: 'beta', displayName: 'Beta team', projectLabel: 'Beta project',
                status: 'idle', statusLabel: 'Running',
              },
            ],
            onOpen: openTeam,
          }}
        />
      </TooltipProvider>
    ));
  }

  it('filters loaded running rows and recent projects with one query and clears to input focus', () => {
    render();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    expect(host.textContent).toContain('Alpha team');
    expect(host.textContent).toContain('Beta project');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('Alpha team');
    expect(host.textContent).toContain('Alpha project');
    expect(host.textContent).not.toContain('Beta team');
    expect(host.textContent).not.toContain('Beta project');

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Alpha team"]')!.click());
    expect(openTeam).toHaveBeenCalledExactlyOnceWith('alpha');
    const clear = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Clear search')!;
    act(() => clear.click());
    expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain('Beta team');
  });

  it('clears the query when the Dashboard scope changes', () => {
    render('workspace-a');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).not.toContain('Beta team');

    render('workspace-b');
    expect(input.value).toBe('');
    expect(host.textContent).toContain('Beta team');
    render('workspace-a');
    expect(input.value).toBe('');
  });

  it('does not steal focus or install a palette shortcut while mounted or hidden', () => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    render();
    expect(document.activeElement).toBe(other);
    act(() => other.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true,
    })));
    expect(openPalette).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(document.activeElement).toBe(other);
    other.remove();
    root = createRoot(host);
  });
});
