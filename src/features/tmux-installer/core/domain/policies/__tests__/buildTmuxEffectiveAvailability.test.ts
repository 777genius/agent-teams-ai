import { describe, expect, it } from 'vitest';

import { buildTmuxEffectiveAvailability } from '../buildTmuxEffectiveAvailability';

describe('buildTmuxEffectiveAvailability', () => {
  it('marks host tmux as runtime-ready on native platforms', () => {
    const result = buildTmuxEffectiveAvailability({
      platform: 'linux',
      nativeSupported: true,
      host: {
        available: true,
        version: 'tmux 3.4',
        binaryPath: '/usr/bin/tmux',
        error: null,
      },
      wsl: null,
    });

    expect(result.available).toBe(true);
    expect(result.location).toBe('host');
    expect(result.runtimeReady).toBe(true);
  });

  it('keeps WSL tmux visible but non-runtime-ready on Windows', () => {
    const result = buildTmuxEffectiveAvailability({
      platform: 'win32',
      nativeSupported: false,
      host: {
        available: false,
        version: null,
        binaryPath: null,
        error: null,
      },
      wsl: {
        wslInstalled: true,
        rebootRequired: false,
        distroName: 'Ubuntu',
        distroVersion: 2,
        distroBootstrapped: true,
        innerPackageManager: 'apt',
        tmuxAvailableInsideWsl: true,
        tmuxVersion: 'tmux 3.4',
        tmuxBinaryPath: '/usr/bin/tmux',
        statusDetail: 'tmux is available in WSL.',
      },
    });

    expect(result.available).toBe(true);
    expect(result.location).toBe('wsl');
    expect(result.runtimeReady).toBe(false);
    expect(result.version).toBe('tmux 3.4');
  });

  it('keeps Windows host tmux non-runtime-ready without WSL tmux', () => {
    const result = buildTmuxEffectiveAvailability({
      platform: 'win32',
      nativeSupported: false,
      host: {
        available: true,
        version: 'tmux 3.4',
        binaryPath: 'C:\\tmux.exe',
        error: null,
      },
      wsl: {
        wslInstalled: true,
        rebootRequired: false,
        distroName: 'Ubuntu',
        distroVersion: 2,
        distroBootstrapped: true,
        innerPackageManager: 'apt',
        tmuxAvailableInsideWsl: false,
        tmuxVersion: null,
        tmuxBinaryPath: null,
        statusDetail: 'tmux is missing in WSL.',
      },
    });

    expect(result.available).toBe(true);
    expect(result.location).toBe('host');
    expect(result.runtimeReady).toBe(false);
  });
});
