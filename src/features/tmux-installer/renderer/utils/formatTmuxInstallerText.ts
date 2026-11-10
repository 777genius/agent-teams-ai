import type { TmuxInstallerPhase } from '@features/tmux-installer/contracts';
import type { TmuxPlatform } from '@features/tmux-installer/contracts';

export function formatTmuxInstallerTitle(phase: TmuxInstallerPhase): string {
  if (phase === 'preparing' || phase === 'checking') return 'Preparing tmux installation';
  if (phase === 'pending_external_elevation') return 'Waiting for an administrator step';
  if (phase === 'waiting_for_external_step') return 'Finish the external setup step';
  if (phase === 'installing') return 'Installing tmux';
  if (phase === 'verifying') return 'Verifying tmux installation';
  if (phase === 'needs_restart') return 'Restart required before tmux setup can continue';
  if (phase === 'error') return 'tmux installation failed';
  if (phase === 'needs_manual_step') return 'tmux needs a manual step';
  if (phase === 'completed') return 'tmux installed';
  if (phase === 'cancelled') return 'tmux installation cancelled';
  return 'tmux is not installed';
}

export function formatInstallButtonLabel(phase: TmuxInstallerPhase): string {
  if (phase === 'error') return 'Retry install';
  if (phase === 'needs_manual_step') return 'Re-check';
  if (phase === 'needs_restart') return 'Re-check after restart';
  if (
    phase === 'preparing' ||
    phase === 'checking' ||
    phase === 'pending_external_elevation' ||
    phase === 'waiting_for_external_step' ||
    phase === 'installing' ||
    phase === 'verifying'
  ) {
    return 'Installing...';
  }
  return 'Install tmux';
}

export function formatTmuxInstallerProgress(phase: TmuxInstallerPhase): number | null {
  if (phase === 'checking') return 8;
  if (phase === 'preparing') return 18;
  if (phase === 'requesting_privileges') return 32;
  if (phase === 'pending_external_elevation') return 32;
  if (phase === 'waiting_for_external_step') return 48;
  if (phase === 'installing') return 68;
  if (phase === 'verifying') return 90;
  if (phase === 'needs_restart') return 96;
  if (phase === 'completed') return 100;
  if (phase === 'needs_manual_step') return 82;
  if (phase === 'error') return 100;
  if (phase === 'cancelled') return 0;
  return null;
}

export function formatTmuxPlatformLabel(platform: TmuxPlatform | null): string | null {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  if (platform === 'unknown') return 'Unknown OS';
  return null;
}

export function formatTmuxLocationLabel(location: 'host' | 'wsl' | null): string | null {
  if (location === 'host') return 'Host runtime';
  if (location === 'wsl') return 'WSL runtime';
  return null;
}

export function formatTmuxOptionalBenefits(platform: TmuxPlatform | null): string | null {
  if (!platform) {
    return null;
  }

  if (platform === 'win32') {
    return 'Optional. The app works without tmux. Install WSL-backed tmux only if you want pane-based terminal transport for long-running teammate sessions.';
  }

  return 'Optional. The app works without tmux. Install tmux only if you want pane-based terminal transport for long-running teammate sessions.';
}
