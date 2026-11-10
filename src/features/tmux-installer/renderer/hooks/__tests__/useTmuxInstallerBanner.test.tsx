import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTmuxInstallerBanner } from '../useTmuxInstallerBanner';

import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';

type HookResult = ReturnType<typeof useTmuxInstallerBanner>;

const baseStatus: TmuxStatus = {
  platform: 'darwin',
  nativeSupported: true,
  checkedAt: new Date().toISOString(),
  host: {
    available: false,
    version: null,
    binaryPath: null,
    error: null,
  },
  effective: {
    available: false,
    location: null,
    version: null,
    binaryPath: null,
    runtimeReady: false,
    detail: 'tmux is optional. Install it only if you want pane transport.',
  },
  error: null,
  autoInstall: {
    supported: true,
    strategy: 'homebrew',
    packageManagerLabel: 'Homebrew',
    requiresTerminalInput: false,
    requiresAdmin: false,
    requiresRestart: false,
    mayOpenExternalWindow: false,
    reasonIfUnsupported: null,
    manualHints: [],
  },
};

const idleSnapshot: TmuxInstallerSnapshot = {
  phase: 'idle',
  strategy: null,
  message: null,
  detail: null,
  error: null,
  canCancel: false,
  acceptsInput: false,
  inputPrompt: null,
  inputSecret: false,
  logs: [],
  updatedAt: new Date().toISOString(),
};

let capturedHook: HookResult | null = null;
let progressListener: ((event: unknown, progress: TmuxInstallerSnapshot) => void) | null = null;

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    isElectronMode: vi.fn(() => true),
    tmux: {
      getStatus: vi.fn<() => Promise<TmuxStatus>>(),
      getInstallerSnapshot: vi.fn<() => Promise<TmuxInstallerSnapshot>>(),
      install: vi.fn<() => Promise<void>>(),
      cancelInstall: vi.fn<() => Promise<void>>(),
      submitInstallerInput: vi.fn<(input: string) => Promise<void>>(),
      onProgress:
        vi.fn<
          (callback: (event: unknown, progress: TmuxInstallerSnapshot) => void) => () => void
        >(),
    },
    openExternal: vi.fn<(url: string) => Promise<void>>(),
  },
}));

vi.mock('@renderer/api', () => ({
  api: mockApi,
  isElectronMode: mockApi.isElectronMode,
}));

function Harness(): React.JSX.Element | null {
  capturedHook = useTmuxInstallerBanner();
  return null;
}

describe('useTmuxInstallerBanner', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    capturedHook = null;
    progressListener = null;
    mockApi.isElectronMode.mockReturnValue(true);
    mockApi.tmux.getStatus.mockResolvedValue(baseStatus);
    mockApi.tmux.getInstallerSnapshot.mockResolvedValue(idleSnapshot);
    mockApi.tmux.install.mockResolvedValue(undefined);
    mockApi.tmux.cancelInstall.mockResolvedValue(undefined);
    mockApi.tmux.submitInstallerInput.mockResolvedValue(undefined);
    mockApi.openExternal.mockResolvedValue(undefined);
    mockApi.tmux.onProgress.mockImplementation((callback) => {
      progressListener = callback;
      return () => {
        if (progressListener === callback) {
          progressListener = null;
        }
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    progressListener = null;
    capturedHook = null;
    document.body.innerHTML = '';
  });

  it('loads tmux status immediately on mount', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.tmux.getStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.tmux.getInstallerSnapshot).toHaveBeenCalledTimes(1);
    expect(capturedHook?.viewModel.visible).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('stays idle and hidden outside Electron mode', async () => {
    mockApi.isElectronMode.mockReturnValue(false);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.tmux.getStatus).not.toHaveBeenCalled();
    expect(mockApi.tmux.getInstallerSnapshot).not.toHaveBeenCalled();
    expect(capturedHook?.viewModel.visible).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('refreshes tmux status again after error and cancelled progress events', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    mockApi.tmux.getStatus.mockClear();
    mockApi.tmux.getInstallerSnapshot.mockClear();

    await act(async () => {
      progressListener?.(null, {
        ...idleSnapshot,
        phase: 'error',
        error: 'tmux install failed',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.tmux.getStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.tmux.getInstallerSnapshot).toHaveBeenCalledTimes(1);

    mockApi.tmux.getStatus.mockClear();
    mockApi.tmux.getInstallerSnapshot.mockClear();

    await act(async () => {
      progressListener?.(null, {
        ...idleSnapshot,
        phase: 'cancelled',
        message: 'tmux installation cancelled',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.tmux.getStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.tmux.getInstallerSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the banner visible during background refreshes after installer progress updates', async () => {
    let resolveStatus: ((value: TmuxStatus) => void) | null = null;
    let resolveSnapshot: ((value: TmuxInstallerSnapshot) => void) | null = null;
    mockApi.tmux.getStatus.mockResolvedValueOnce(baseStatus).mockImplementationOnce(
      () =>
        new Promise<TmuxStatus>((resolve) => {
          resolveStatus = resolve;
        })
    );
    mockApi.tmux.getInstallerSnapshot.mockResolvedValueOnce(idleSnapshot).mockImplementationOnce(
      () =>
        new Promise<TmuxInstallerSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.visible).toBe(true);

    await act(async () => {
      progressListener?.(null, {
        ...idleSnapshot,
        phase: 'waiting_for_external_step',
        message: 'Finish Ubuntu setup in WSL',
      });
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.visible).toBe(true);
    expect(capturedHook?.viewModel.phase).toBe('waiting_for_external_step');

    await act(async () => {
      resolveStatus?.(baseStatus);
      resolveSnapshot?.({
        ...idleSnapshot,
        phase: 'waiting_for_external_step',
        message: 'Finish Ubuntu setup in WSL',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.visible).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not let an older refreshed snapshot overwrite newer live progress', async () => {
    let resolveStatus: ((value: TmuxStatus) => void) | null = null;
    let resolveSnapshot: ((value: TmuxInstallerSnapshot) => void) | null = null;
    const olderSnapshot = {
      ...idleSnapshot,
      phase: 'idle' as const,
      updatedAt: '2099-04-14T10:00:00.000Z',
    };
    const newerProgress = {
      ...idleSnapshot,
      phase: 'waiting_for_external_step' as const,
      message: 'Finish Ubuntu setup in WSL',
      updatedAt: '2099-04-14T10:00:05.000Z',
    };

    mockApi.tmux.getStatus.mockResolvedValueOnce(baseStatus).mockImplementationOnce(
      () =>
        new Promise<TmuxStatus>((resolve) => {
          resolveStatus = resolve;
        })
    );
    mockApi.tmux.getInstallerSnapshot.mockResolvedValueOnce(idleSnapshot).mockImplementationOnce(
      () =>
        new Promise<TmuxInstallerSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      progressListener?.(null, newerProgress);
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.phase).toBe('waiting_for_external_step');

    await act(async () => {
      resolveStatus?.({
        ...baseStatus,
        checkedAt: '2099-04-14T10:00:00.000Z',
      });
      resolveSnapshot?.(olderSnapshot);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.phase).toBe('waiting_for_external_step');
    expect(capturedHook?.viewModel.title).toBe('Finish Ubuntu setup in WSL');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('stores action errors instead of letting rejected installer calls disappear', async () => {
    mockApi.tmux.install.mockRejectedValueOnce(new Error('bridge failed'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await capturedHook?.install();
      await Promise.resolve();
    });

    expect(capturedHook?.viewModel.error).toBe('bridge failed');
    expect(capturedHook?.viewModel.body).toBe('bridge failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
