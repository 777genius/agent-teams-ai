import { describe, expect, it, vi } from 'vitest';

import { CancelTmuxInstallUseCase } from '../CancelTmuxInstallUseCase';
import { GetTmuxInstallerSnapshotUseCase } from '../GetTmuxInstallerSnapshotUseCase';
import { GetTmuxStatusUseCase } from '../GetTmuxStatusUseCase';
import { InstallTmuxUseCase } from '../InstallTmuxUseCase';

import type { TmuxInstallerRunnerPort } from '../../ports/TmuxInstallerRunnerPort';
import type { TmuxInstallerSnapshotPort } from '../../ports/TmuxInstallerSnapshotPort';
import type { TmuxStatusSourcePort } from '../../ports/TmuxStatusSourcePort';
import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';

describe('tmux installer use cases', () => {
  it('delegates status loading to the status source port', async () => {
    const status: TmuxStatus = {
      platform: 'linux',
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
        detail: 'detail',
      },
      error: null,
      autoInstall: {
        supported: true,
        strategy: 'apt',
        packageManagerLabel: 'APT',
        requiresTerminalInput: false,
        requiresAdmin: true,
        requiresRestart: false,
        mayOpenExternalWindow: false,
        reasonIfUnsupported: null,
        manualHints: [],
      },
    };
    const getStatusMock = vi.fn().mockResolvedValue(status);
    const statusSource: TmuxStatusSourcePort = {
      getStatus: getStatusMock,
      invalidateStatus: vi.fn(),
    };

    const result = await new GetTmuxStatusUseCase(statusSource).execute();

    expect(result).toBe(status);
    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  it('delegates install and cancel orchestration to the runner port', async () => {
    const installMock = vi.fn().mockResolvedValue(undefined);
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const runner: TmuxInstallerRunnerPort = {
      install: installMock,
      cancel: cancelMock,
      submitInput: vi.fn().mockResolvedValue(undefined),
    };

    await new InstallTmuxUseCase(runner).execute();
    await new CancelTmuxInstallUseCase(runner).execute();

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('returns the snapshot from the snapshot port unchanged', () => {
    const snapshot: TmuxInstallerSnapshot = {
      phase: 'installing',
      strategy: 'homebrew',
      message: 'Installing...',
      detail: null,
      error: null,
      canCancel: true,
      acceptsInput: false,
      inputPrompt: null,
      inputSecret: false,
      logs: ['line 1'],
      updatedAt: new Date().toISOString(),
    };
    const getSnapshotMock = vi.fn().mockReturnValue(snapshot);
    const snapshotPort: TmuxInstallerSnapshotPort = {
      getSnapshot: getSnapshotMock,
    };

    const result = new GetTmuxInstallerSnapshotUseCase(snapshotPort).execute();

    expect(result).toBe(snapshot);
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
