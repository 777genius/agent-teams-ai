/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror PascalCase exports. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pane } from '@renderer/types/panes';
import type { Tab } from '@renderer/types/tabs';

vi.mock('../dashboard/DashboardView', () => ({
  DashboardView: () => React.createElement('div', { 'data-view': 'dashboard' }, 'Dashboard view'),
}));

vi.mock('../extensions/ExtensionStoreView', () => ({
  ExtensionStoreView: () =>
    React.createElement('div', { 'data-view': 'extensions' }, 'Extension store view'),
}));

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

  it('renders the default dashboard without suspending when no tabs are open', async () => {
    const { host, root } = createHarness();

    await renderPane(root, createPane([], null));

    expect(host.textContent).toContain('Dashboard view');
    expect(host.querySelector('[role="status"]')).toBeNull();
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

    await renderPane(root, createPane([dashboardTab, extensionTab], extensionTab.id));
    await waitForText(host, 'Extension store view');

    const extensionView = host.querySelector<HTMLElement>('[data-view="extensions"]');
    expect(extensionView).not.toBeNull();

    await renderPane(root, createPane([dashboardTab, extensionTab], dashboardTab.id));

    expect(host.querySelector('[data-view="extensions"]')).toBe(extensionView);
    expect(extensionView?.closest<HTMLElement>('.absolute')?.style.display).toBe('none');
  });
});
