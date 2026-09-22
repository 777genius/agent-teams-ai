import { describe, expect, it } from 'vitest';

import { buildTmuxAutoInstallCapability } from '../buildTmuxAutoInstallCapability';

describe('buildTmuxAutoInstallCapability', () => {
  it('supports Homebrew installs on macOS without extra terminal input', () => {
    const capability = buildTmuxAutoInstallCapability({
      platform: 'darwin',
      strategy: 'homebrew',
      packageManagerLabel: 'Homebrew',
      nonInteractivePrivilegeAvailable: true,
    });

    expect(capability).toMatchObject({
      supported: true,
      strategy: 'homebrew',
      requiresTerminalInput: false,
      requiresAdmin: false,
      requiresRestart: false,
    });
    expect(capability.manualHints.some((hint) => hint.command === 'brew install tmux')).toBe(true);
  });

  it('falls back to manual terminal install when sudo cannot run non-interactively', () => {
    const capability = buildTmuxAutoInstallCapability({
      platform: 'linux',
      strategy: 'apt',
      packageManagerLabel: 'APT',
      nonInteractivePrivilegeAvailable: false,
    });

    expect(capability).toMatchObject({
      supported: false,
      strategy: 'apt',
      requiresTerminalInput: true,
      requiresAdmin: true,
      requiresRestart: false,
    });
    expect(capability.reasonIfUnsupported).toContain('Administrator privileges are required');
  });

  it('keeps auto-install enabled when interactive terminal input is available', () => {
    const capability = buildTmuxAutoInstallCapability({
      platform: 'linux',
      strategy: 'apt',
      packageManagerLabel: 'APT',
      nonInteractivePrivilegeAvailable: false,
      interactiveTerminalAvailable: true,
    });

    expect(capability).toMatchObject({
      supported: true,
      strategy: 'apt',
      requiresTerminalInput: true,
      requiresAdmin: true,
    });
  });

  it('keeps immutable Linux hosts manual-only in this iteration', () => {
    const capability = buildTmuxAutoInstallCapability({
      platform: 'linux',
      strategy: 'apt',
      packageManagerLabel: 'APT',
      immutableHost: true,
      nonInteractivePrivilegeAvailable: true,
    });

    expect(capability).toMatchObject({
      supported: false,
      strategy: 'manual',
      requiresAdmin: true,
      requiresRestart: false,
    });
    expect(capability.reasonIfUnsupported).toContain('Immutable Linux hosts');
  });

  it('marks Windows as a WSL follow-up flow for now', () => {
    const capability = buildTmuxAutoInstallCapability({
      platform: 'win32',
      strategy: 'wsl',
      packageManagerLabel: 'WSL',
      nonInteractivePrivilegeAvailable: false,
    });

    expect(capability).toMatchObject({
      supported: false,
      strategy: 'wsl',
      requiresTerminalInput: true,
      requiresAdmin: true,
      requiresRestart: true,
      mayOpenExternalWindow: true,
    });
    expect(capability.reasonIfUnsupported).toContain('not wired');
  });
});
