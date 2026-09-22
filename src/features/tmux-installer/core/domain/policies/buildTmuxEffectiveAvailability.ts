import type {
  TmuxBinaryProbe,
  TmuxEffectiveAvailability,
  TmuxPlatform,
  TmuxWslStatus,
} from '@features/tmux-installer/contracts';

interface BuildTmuxEffectiveAvailabilityInput {
  platform: TmuxPlatform;
  nativeSupported: boolean;
  host: TmuxBinaryProbe;
  wsl: TmuxWslStatus | null;
}

export function buildTmuxEffectiveAvailability(
  input: BuildTmuxEffectiveAvailabilityInput
): TmuxEffectiveAvailability {
  if (input.platform === 'win32') {
    if (input.wsl?.tmuxAvailableInsideWsl) {
      return {
        available: true,
        location: 'wsl',
        version: input.wsl.tmuxVersion,
        binaryPath: input.wsl.tmuxBinaryPath,
        runtimeReady: false,
        detail:
          'tmux is available inside WSL. On Windows it is optional and is not required for teammate runtime startup.',
      };
    }

    if (input.host.available) {
      return {
        available: true,
        location: 'host',
        version: input.host.version,
        binaryPath: input.host.binaryPath,
        runtimeReady: false,
        detail:
          'tmux was found on Windows. Native process teammates do not require it; tmux remains optional for pane-based terminal transport.',
      };
    }

    if (!input.wsl?.wslInstalled) {
      return {
        available: false,
        location: null,
        version: null,
        binaryPath: null,
        runtimeReady: false,
        detail:
          input.wsl?.statusDetail ??
          'You can keep using the app without tmux. Install WSL only if you want optional tmux pane transport.',
      };
    }

    return {
      available: false,
      location: null,
      version: null,
      binaryPath: null,
      runtimeReady: false,
      detail:
        input.wsl?.statusDetail ??
        'WSL is available, but tmux is not ready there yet. Install tmux only if you want optional pane transport.',
    };
  }

  if (input.host.available) {
    return {
      available: true,
      location: 'host',
      version: input.host.version,
      binaryPath: input.host.binaryPath,
      runtimeReady: input.nativeSupported,
      detail: 'tmux is available.',
    };
  }

  return {
    available: false,
    location: null,
    version: null,
    binaryPath: null,
    runtimeReady: false,
    detail:
      input.platform === 'darwin'
        ? 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.'
        : input.platform === 'linux'
          ? 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.'
          : 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.',
  };
}
