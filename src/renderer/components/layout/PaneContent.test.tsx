/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror PascalCase exports. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pane } from '@renderer/types/panes';
import type { Tab } from '@renderer/types/tabs';

const teamDetailViewMock = vi.hoisted(() => {
  let resolve: (module: unknown) => void = () => undefined;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
});

const routeImports = vi.hoisted(() => ({ dashboard: 0, settings: 0 }));

vi.mock('../dashboard/DashboardView', () => {
  routeImports.dashboard += 1;
  return {
    DashboardView: ({ isActive = true }: { isActive?: boolean }) =>
      React.createElement(
        'div',
        { 'data-view': 'dashboard', 'data-active': String(isActive) },
        'Dashboard view'
      ),
  };
});

vi.mock('../settings/SettingsView', () => {
  routeImports.settings += 1;
  return {
    SettingsView: ({ isActive = true }: { isActive?: boolean }) => {
      const [value, setValue] = React.useState(0);
      return React.createElement(
        'button',
        {
          'data-view': 'settings',
          'data-active': String(isActive),
          onClick: () => setValue(value + 1),
        },
        `Settings value ${value}`
      );
    },
  };
});

vi.mock('../extensions/ExtensionStoreView', () => ({
  ExtensionStoreView: () =>
    React.createElement('div', { 'data-view': 'extensions' }, 'Extension store view'),
}));

vi.mock('../team/TeamDetailView', () => teamDetailViewMock.promise);

/* eslint-enable @typescript-eslint/naming-convention -- Re-enable after component mocks. */

import { PaneContent } from './PaneContent';

const flushReact = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const roots: Root[] = [];

const dashboardTab: Tab = {
  id: 'tab-dashboard',
  type: 'dashboard',
  label: 'Dashboard',
  createdAt: 1,
};

const extensionTab: Tab = {
  id: 'tab-extensions',
  type: 'extensions',
  label: 'Extensions',
  createdAt: 2,
};

const teamTab: Tab = {
  id: 'tab-team-alpha',
  type: 'team',
  label: 'Alpha',
  teamName: 'team-alpha',
  createdAt: 3,
};

const settingsTab: Tab = {
  id: 'tab-settings',
  type: 'settings',
  label: 'Settings',
  createdAt: 4,
};

const createPane = (tabs: Tab[], activeTabId: string | null): Pane => ({
  id: 'pane-main',
  tabs,
  activeTabId,
  selectedTabIds: [],
  widthFraction: 1,
});

const createHarness = (): { host: HTMLDivElement; root: Root } => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
};

const renderPane = async (root: Root, pane: Pane): Promise<void> => {
  await act(async () => {
    root.render(<PaneContent pane={pane} isPaneFocused />);
    await flushReact();
  });
};

const waitForText = async (host: HTMLElement, text: string): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (host.textContent?.includes(text)) {
      return;
    }

    await act(async () => {
      await flushReact();
    });
  }

  expect(host.textContent).toContain(text);
};

describe('PaneContent', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
      await flushReact();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('contains the default dashboard load in a local fallback and then renders it', async () => {
    const { host, root } = createHarness();

    expect(routeImports.dashboard).toBe(0);
    act(() => {
      root.render(<PaneContent pane={createPane([], null)} isPaneFocused />);
    });

    expect(host.textContent).not.toContain('Dashboard view');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await waitForText(host, 'Dashboard view');

    expect(routeImports.dashboard).toBe(1);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('imports Settings on activation and preserves its local state across tab switches', async () => {
    const { host, root } = createHarness();
    const tabs = [dashboardTab, settingsTab];

    await renderPane(root, createPane(tabs, dashboardTab.id));
    expect(routeImports.settings).toBe(0);
    expect(host.querySelector('[data-view="settings"]')).toBeNull();

    await renderPane(root, createPane(tabs, settingsTab.id));
    await waitForText(host, 'Settings value 0');
    expect(routeImports.settings).toBe(1);
    const settingsView = host.querySelector<HTMLButtonElement>('[data-view="settings"]')!;
    expect(settingsView.getAttribute('data-active')).toBe('true');
    await act(async () => {
      settingsView.click();
    });
    expect(settingsView.textContent).toBe('Settings value 1');

    await renderPane(root, createPane(tabs, dashboardTab.id));
    expect(host.querySelector('[data-view="settings"]')).toBe(settingsView);
    expect(settingsView.getAttribute('data-active')).toBe('false');
    expect(settingsView.closest<HTMLElement>('.absolute')?.style.display).toBe('none');

    await renderPane(root, createPane(tabs, settingsTab.id));
    expect(routeImports.settings).toBe(1);
    expect(host.querySelector('[data-view="settings"]')).toBe(settingsView);
    expect(settingsView.textContent).toBe('Settings value 1');
    expect(settingsView.getAttribute('data-active')).toBe('true');
  });

  it('does not mount inactive lazy tab content during initial pane render', async () => {
    const { host, root } = createHarness();

    await renderPane(root, createPane([dashboardTab, extensionTab], dashboardTab.id));

    expect(host.textContent).toContain('Dashboard view');
    expect(host.textContent).not.toContain('Extension store view');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('loads a lazy tab on first activation and keeps it mounted after switching away', async () => {
    const { host, root } = createHarness();

    await renderPane(root, createPane([dashboardTab, extensionTab], dashboardTab.id));
    expect(host.textContent).not.toContain('Extension store view');
    expect(host.querySelector('[data-view="dashboard"]')?.getAttribute('data-active')).toBe('true');

    await renderPane(root, createPane([dashboardTab, extensionTab], extensionTab.id));
    await waitForText(host, 'Extension store view');
    expect(host.querySelector('[data-view="dashboard"]')?.getAttribute('data-active')).toBe(
      'false'
    );

    const extensionView = host.querySelector<HTMLElement>('[data-view="extensions"]');
    expect(extensionView).not.toBeNull();

    await renderPane(root, createPane([dashboardTab, extensionTab], dashboardTab.id));

    expect(host.querySelector('[data-view="extensions"]')).toBe(extensionView);
    expect(extensionView?.closest<HTMLElement>('.absolute')?.style.display).toBe('none');
    expect(host.querySelector('[data-view="dashboard"]')?.getAttribute('data-active')).toBe('true');
  });

  it('uses the team loading skeleton while the team tab chunk is loading', async () => {
    const { host, root } = createHarness();

    await renderPane(root, createPane([teamTab], teamTab.id));

    const skeleton = host.querySelector<HTMLElement>(
      '[role="status"][data-team-name="team-alpha"]'
    );
    expect(skeleton).not.toBeNull();
    expect(host.querySelector('.size-5.animate-spin')).toBeNull();
  });
});
