/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror PascalCase exports. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => ({
  state: {
    sidebarCollapsed: false,
    toggleSidebar: vi.fn(),
  },
  sessionsModuleLoads: 0,
}));

vi.mock('@renderer/store', () => ({
  useStore: <T,>(selector: (state: typeof storeMock.state) => T): T => selector(storeMock.state),
}));

vi.mock('../sidebar/GlobalTaskList', () => ({
  GlobalTaskList: () => React.createElement('div', { 'data-testid': 'tasks-panel' }, 'Tasks panel'),
}));

vi.mock('../sidebar/DateGroupedSessions', () => {
  storeMock.sessionsModuleLoads += 1;
  return {
    DateGroupedSessions: () =>
      React.createElement('div', { 'data-testid': 'sessions-panel' }, 'Sessions panel'),
  };
});

/* eslint-enable @typescript-eslint/naming-convention -- Re-enable after component mocks. */

import { Sidebar } from './Sidebar';

const roots: Root[] = [];

const flushReact = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const createHarness = (): { host: HTMLDivElement; root: Root } => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
};

const renderSidebar = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<Sidebar />);
    await flushReact();
  });
};

describe('Sidebar', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeMock.state.sidebarCollapsed = false;
    storeMock.state.toggleSidebar.mockClear();
    storeMock.sessionsModuleLoads = 0;
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

  it('does not mount the sessions panel before the sessions tab is opened', async () => {
    const { host, root } = createHarness();

    await renderSidebar(root);

    expect(host.querySelector('[data-testid="tasks-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sessions-panel"]')).toBeNull();
    expect(storeMock.sessionsModuleLoads).toBe(0);
  });

  it('keeps the hidden sessions tab unmounted in the tasks-only sidebar', async () => {
    const { host, root } = createHarness();
    await renderSidebar(root);

    const buttons = Array.from(host.querySelectorAll('button')).map((button) =>
      button.textContent?.trim()
    );

    expect(buttons).not.toContain('Sessions');
    expect(host.querySelector('[data-testid="tasks-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sessions-panel"]')).toBeNull();
    expect(storeMock.sessionsModuleLoads).toBe(0);
  });
});
