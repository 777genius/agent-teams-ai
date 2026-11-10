import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStore = vi.hoisted(() => {
  const state = {
    messagesPanelMode: 'inline' as 'sidebar' | 'inline' | 'bottom-sheet',
    setMessagesPanelMode: vi.fn((mode: 'sidebar' | 'inline' | 'bottom-sheet') => {
      state.messagesPanelMode = mode;
    }),
  };

  return { state };
});

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mockStore.state) => unknown) => selector(mockStore.state),
}));

import { useGraphSidebarVisibility } from '@features/agent-graph/renderer/hooks/useGraphSidebarVisibility';

function HookProbe(): React.JSX.Element {
  const { sidebarVisible, toggleSidebarVisible } = useGraphSidebarVisibility();

  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: toggleSidebarVisible,
      'data-visible': sidebarVisible ? 'true' : 'false',
    },
    sidebarVisible ? 'visible' : 'hidden'
  );
}

describe('useGraphSidebarVisibility', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mockStore.state.messagesPanelMode = 'inline';
    mockStore.state.setMessagesPanelMode.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('forces sidebar mode on open when the messages panel is not currently in sidebar mode', async () => {
    window.localStorage.setItem('team-graph-sidebar-visible', 'false');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(HookProbe));
      await Promise.resolve();
    });

    const button = host.querySelector('button');
    expect(button?.getAttribute('data-visible')).toBe('false');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockStore.state.setMessagesPanelMode).toHaveBeenCalledWith('sidebar');
    expect(button?.getAttribute('data-visible')).toBe('true');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides the graph sidebar locally without changing the global messages panel mode', async () => {
    mockStore.state.messagesPanelMode = 'sidebar';
    window.localStorage.setItem('team-graph-sidebar-visible', 'true');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(HookProbe));
      await Promise.resolve();
    });

    const button = host.querySelector('button');
    expect(button?.getAttribute('data-visible')).toBe('true');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockStore.state.setMessagesPanelMode).not.toHaveBeenCalled();
    expect(button?.getAttribute('data-visible')).toBe('false');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
