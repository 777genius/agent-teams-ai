import { describe, expect, it } from 'vitest';

import { TmuxInstallerBannerAdapter } from '../TmuxInstallerBannerAdapter';

import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';

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
    detail: 'tmux improves persistent teammate reliability.',
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
    manualHints: [{ title: 'Homebrew', description: 'Recommended', command: 'brew install tmux' }],
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

describe('TmuxInstallerBannerAdapter', () => {
  it('builds an install-ready view model for unavailable tmux', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: baseStatus,
      snapshot: idleSnapshot,
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.visible).toBe(true);
    expect(result.installSupported).toBe(true);
    expect(result.installDisabled).toBe(false);
    expect(result.installLabel).toBe('Install tmux');
    expect(result.platformLabel).toBe('macOS');
    expect(result.runtimeReadyLabel).toBeNull();
    expect(result.primaryGuideUrl).toBeNull();
    expect(result.progressPercent).toBeNull();
    expect(result.manualHints).toHaveLength(1);
    expect(result.manualHintsCollapsible).toBe(false);
    expect(result.body).toContain('persistent teammate reliability');
    expect(result.benefitsBody).toContain('Optional, but recommended');
    expect(result.benefitsBody).toContain('multi-agent teams that mix providers');
    expect(result.installButtonPrimary).toBe(true);
    expect(result.showRefreshButton).toBe(true);
  });

  it('prioritizes renderer errors and disables the install button while installing', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: baseStatus,
      snapshot: {
        ...idleSnapshot,
        phase: 'installing',
        strategy: 'homebrew',
        message: 'brew install tmux',
        canCancel: true,
        acceptsInput: false,
        inputPrompt: null,
        inputSecret: false,
        logs: ['Downloading bottle...'],
      },
      loading: false,
      error: 'Renderer bridge failed',
      detailsOpen: true,
    });

    expect(result.title).toBe('Installing tmux');
    expect(result.body).toBe('Renderer bridge failed');
    expect(result.benefitsBody).toContain('Optional, but recommended');
    expect(result.error).toBe('Renderer bridge failed');
    expect(result.installDisabled).toBe(true);
    expect(result.canCancel).toBe(true);
    expect(result.acceptsInput).toBe(false);
    expect(result.progressPercent).toBe(68);
    expect(result.logs).toEqual(['Downloading bottle...']);
    expect(result.installButtonPrimary).toBe(false);
  });

  it('keeps the banner visible while loading if installer progress is already active', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: null,
      snapshot: {
        ...idleSnapshot,
        phase: 'waiting_for_external_step',
        strategy: 'wsl',
        message: 'Finish Ubuntu setup in WSL',
      },
      loading: true,
      error: null,
      detailsOpen: false,
    });

    expect(result.visible).toBe(true);
    expect(result.title).toBe('Finish Ubuntu setup in WSL');
  });

  it('exposes a manual guide url when auto install is unavailable', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        effective: {
          ...baseStatus.effective,
          detail: 'WSL is installed, but tmux still needs to be installed there.',
        },
        autoInstall: {
          ...baseStatus.autoInstall,
          supported: false,
          strategy: 'wsl',
          manualHints: [
            {
              title: 'Microsoft WSL',
              description: 'Official WSL docs',
              url: 'https://learn.microsoft.com/en-us/windows/wsl/install',
            },
          ],
        },
      },
      snapshot: {
        ...idleSnapshot,
        phase: 'needs_manual_step',
        strategy: 'wsl',
        detail: 'WSL wizard is not wired yet.',
      },
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.platformLabel).toBe('Windows');
    expect(result.primaryGuideUrl).toBe('https://learn.microsoft.com/en-us/windows/wsl/install');
    expect(result.progressPercent).toBe(82);
    expect(result.manualHintsCollapsible).toBe(true);
    expect(result.benefitsBody).toContain('With tmux in WSL');
    expect(result.showRefreshButton).toBe(true);
  });

  it('hides the banner when tmux is already installed', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        effective: {
          available: true,
          location: 'host',
          version: 'tmux 3.4',
          binaryPath: 'C:\\tmux.exe',
          runtimeReady: false,
          detail: 'tmux was found on Windows, but WSL-backed tmux is still preferred.',
        },
      },
      snapshot: idleSnapshot,
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.visible).toBe(false);
    expect(result.locationLabel).toBe('Host runtime');
    expect(result.runtimeReadyLabel).toBe('Installed, but not active yet');
    expect(result.versionLabel).toBe('tmux 3.4');
    expect(result.benefitsBody).toBeNull();
  });

  it('hides a completed installer banner once tmux is available', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: {
        ...baseStatus,
        effective: {
          available: true,
          location: 'host',
          version: 'tmux 3.6a',
          binaryPath: '/opt/homebrew/bin/tmux',
          runtimeReady: true,
          detail: 'tmux is available for persistent teammates.',
        },
      },
      snapshot: {
        ...idleSnapshot,
        phase: 'completed',
        strategy: 'homebrew',
        message: 'tmux installed',
      },
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.visible).toBe(false);
  });

  it('exposes installer input metadata for interactive privilege flows', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: baseStatus,
      snapshot: {
        ...idleSnapshot,
        phase: 'requesting_privileges',
        strategy: 'apt',
        acceptsInput: true,
        inputPrompt: 'Enter password if prompted',
        inputSecret: true,
      },
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.acceptsInput).toBe(true);
    expect(result.inputPrompt).toBe('Enter password if prompted');
    expect(result.inputSecret).toBe(true);
  });

  it('uses Windows-specific install labels for the WSL wizard states', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const installWslResult = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        autoInstall: {
          ...baseStatus.autoInstall,
          supported: true,
          strategy: 'wsl',
        },
        wsl: {
          wslInstalled: false,
          rebootRequired: false,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: 'WSL is not installed yet.',
        },
      },
      snapshot: idleSnapshot,
      loading: false,
      error: null,
      detailsOpen: false,
    });
    const installUbuntuResult = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        autoInstall: {
          ...baseStatus.autoInstall,
          supported: true,
          strategy: 'wsl',
        },
        wsl: {
          wslInstalled: true,
          rebootRequired: false,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: 'No distro yet.',
        },
      },
      snapshot: idleSnapshot,
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(installWslResult.installLabel).toBe('Install WSL');
    expect(installUbuntuResult.installLabel).toBe('Install Ubuntu in WSL');
    expect(installWslResult.installButtonPrimary).toBe(true);
    expect(installUbuntuResult.installButtonPrimary).toBe(true);
  });

  it('uses a specific Windows external-step message as the title', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        autoInstall: {
          ...baseStatus.autoInstall,
          supported: true,
          strategy: 'wsl',
        },
      },
      snapshot: {
        ...idleSnapshot,
        phase: 'waiting_for_external_step',
        strategy: 'wsl',
        message: 'Finish Ubuntu setup in WSL',
        detail:
          'Ubuntu installation was started, but Windows has not exposed the distro to the app yet.',
      },
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.title).toBe('Finish Ubuntu setup in WSL');
    expect(result.progressPercent).toBe(48);
    expect(result.installDisabled).toBe(true);
    expect(result.showRefreshButton).toBe(true);
  });

  it('shows a restart state when external-step details already require a reboot', () => {
    const adapter = TmuxInstallerBannerAdapter.create();

    const result = adapter.adapt({
      status: {
        ...baseStatus,
        platform: 'win32',
        autoInstall: {
          ...baseStatus.autoInstall,
          supported: true,
          strategy: 'wsl',
        },
        wsl: {
          wslInstalled: true,
          rebootRequired: false,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: null,
        },
      },
      snapshot: {
        ...idleSnapshot,
        phase: 'waiting_for_external_step',
        strategy: 'wsl',
        message: 'Checking WSL after the administrator step...',
        detail:
          'Требуемая операция выполнена успешно. Чтобы сделанные изменения вступили в силу, следует перезагрузить систему.',
      },
      loading: false,
      error: null,
      detailsOpen: false,
    });

    expect(result.phase).toBe('needs_restart');
    expect(result.progressPercent).toBe(96);
    expect(result.installLabel).toBe('Re-check after restart');
  });
});
