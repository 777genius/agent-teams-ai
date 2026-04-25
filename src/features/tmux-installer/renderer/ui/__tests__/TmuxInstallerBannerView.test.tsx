import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TmuxInstallerBannerView } from '../TmuxInstallerBannerView';

import type { TmuxInstallerBannerViewModel } from '../../adapters/TmuxInstallerBannerAdapter';

const { mockUseTmuxInstallerBanner } = vi.hoisted(() => ({
  mockUseTmuxInstallerBanner: vi.fn(),
}));

vi.mock('../../hooks/useTmuxInstallerBanner', () => ({
  useTmuxInstallerBanner: mockUseTmuxInstallerBanner,
}));

const baseViewModel: TmuxInstallerBannerViewModel = {
  visible: true,
  loading: false,
  title: 'tmux is not installed',
  body: 'WSL is available, but no Linux distribution is installed yet.',
  benefitsBody:
    'Optional, but recommended. The app works without tmux. With tmux in WSL, teammates are more reliable. Without tmux, creating multi-agent teams that mix providers may be blocked.',
  error: null,
  platformLabel: 'Windows',
  locationLabel: null,
  runtimeReadyLabel: null,
  versionLabel: null,
  phase: 'idle',
  progressPercent: null,
  logs: [],
  manualHints: [
    {
      title: 'Install WSL',
      description: 'Install Windows Subsystem for Linux.',
      command: 'wsl --install --no-distribution',
    },
    {
      title: 'Install Ubuntu',
      description: 'Recommended WSL distro.',
      command: 'wsl --install -d Ubuntu --no-launch',
    },
  ],
  manualHintsCollapsible: true,
  primaryGuideUrl: 'https://example.com/guide',
  installSupported: true,
  installDisabled: false,
  installLabel: 'Install Ubuntu in WSL',
  installButtonPrimary: true,
  showRefreshButton: true,
  canCancel: false,
  acceptsInput: false,
  inputPrompt: null,
  inputSecret: false,
  detailsOpen: false,
};

function renderBanner(viewModel: TmuxInstallerBannerViewModel): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mockUseTmuxInstallerBanner.mockReturnValue({
    viewModel,
    install: vi.fn(),
    cancel: vi.fn(),
    submitInput: vi.fn(),
    refresh: vi.fn(),
    toggleDetails: vi.fn(),
    openExternal: vi.fn(),
  });

  act(() => {
    root.render(React.createElement(TmuxInstallerBannerView));
  });

  return { host, root };
}

describe('TmuxInstallerBannerView', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    mockUseTmuxInstallerBanner.mockReset();
    document.body.innerHTML = '';
  });

  it('keeps Windows setup steps collapsed by default and expands them on demand', async () => {
    const { host, root } = renderBanner(baseViewModel);

    expect(host.textContent).toContain('tmux is not installed');
    expect(host.textContent).toContain('Optional, but recommended');
    expect(host.textContent).toContain('multi-agent teams that mix providers');
    expect(host.textContent).not.toContain(
      'WSL is available, but no Linux distribution is installed yet.'
    );
    expect(host.textContent).not.toContain('Show setup steps (2)');
    expect(host.textContent).not.toContain('wsl --install --no-distribution');

    const summaryButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('tmux is not installed')
    );
    expect(summaryButton).toBeDefined();

    await act(async () => {
      summaryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'WSL is available, but no Linux distribution is installed yet.'
    );
    expect(host.textContent).toContain('Show setup steps (2)');
    expect(host.textContent).not.toContain('Hide setup steps');

    const setupToggle = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show setup steps')
    );
    expect(setupToggle).toBeDefined();

    await act(async () => {
      setupToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Hide setup steps');
    expect(host.textContent).toContain('wsl --install --no-distribution');
    expect(host.textContent).toContain('wsl --install -d Ubuntu --no-launch');

    act(() => {
      root.unmount();
    });
  });

  it('shows setup hints immediately on non-Windows platforms', () => {
    const { host, root } = renderBanner({
      ...baseViewModel,
      platformLabel: 'macOS',
      manualHintsCollapsible: false,
      manualHints: [
        { title: 'Homebrew', description: 'Recommended', command: 'brew install tmux' },
      ],
    });

    const summaryButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('tmux is not installed')
    );
    expect(summaryButton).toBeDefined();

    act(() => {
      summaryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('brew install tmux');
    expect(host.textContent).not.toContain('Show setup steps');

    act(() => {
      root.unmount();
    });
  });

  it('auto-expands when installer flow becomes active', async () => {
    const { host, root } = renderBanner(baseViewModel);

    mockUseTmuxInstallerBanner.mockReturnValue({
      viewModel: {
        ...baseViewModel,
        title: 'tmux needs a restart',
        body: 'Restart Windows before continuing.',
        phase: 'needs_restart',
        progressPercent: 96,
      },
      install: vi.fn(),
      cancel: vi.fn(),
      submitInput: vi.fn(),
      refresh: vi.fn(),
      toggleDetails: vi.fn(),
      openExternal: vi.fn(),
    });

    await act(async () => {
      root.render(React.createElement(TmuxInstallerBannerView));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Restart Windows before continuing.');
    expect(host.textContent).toContain('96%');

    act(() => {
      root.unmount();
    });
  });
});
