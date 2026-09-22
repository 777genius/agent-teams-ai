import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDashboard = vi.fn();
const storeState = {
  cliStatus: null as
    | {
        installed: boolean;
        displayName: string;
        binaryPath: string | null;
        launchError: string | null;
      }
    | null,
  cliStatusLoading: false,
  paneLayout: {
    focusedPaneId: 'pane-1',
    panes: [
      {
        id: 'pane-1',
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            type: 'thread',
          },
        ],
      },
    ],
  },
  openDashboard,
};

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import { CliInstallWarningBanner } from '@renderer/components/common/CliInstallWarningBanner';

describe('CliInstallWarningBanner', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    storeState.cliStatus = null;
    storeState.cliStatusLoading = false;
    openDashboard.mockReset();
  });

  it('hides stale runtime errors while status is still loading', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      installed: false,
      displayName: 'Multimodel runtime',
      binaryPath: '/tmp/runtime',
      launchError: 'spawn EACCES',
    };
    storeState.cliStatusLoading = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliInstallWarningBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the banner after loading completes and allows opening the dashboard', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      installed: false,
      displayName: 'Multimodel runtime',
      binaryPath: '/tmp/runtime',
      launchError: 'spawn EACCES',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliInstallWarningBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('failed to start');
    host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
