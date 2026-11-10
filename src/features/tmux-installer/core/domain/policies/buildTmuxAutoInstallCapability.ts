import type {
  TmuxAutoInstallCapability,
  TmuxInstallHint,
  TmuxInstallStrategy,
  TmuxPlatform,
} from '@features/tmux-installer/contracts';

interface BuildTmuxAutoInstallCapabilityInput {
  platform: TmuxPlatform;
  strategy: TmuxInstallStrategy;
  packageManagerLabel?: string | null;
  immutableHost?: boolean;
  nonInteractivePrivilegeAvailable?: boolean;
  interactiveTerminalAvailable?: boolean;
}

const OFFICIAL_TMUX_INSTALL_URL = 'https://github.com/tmux/tmux/wiki/Installing';
const TMUX_README_URL = 'https://github.com/tmux/tmux/blob/master/README';
const HOMEBREW_TMUX_URL = 'https://formulae.brew.sh/formula/tmux';
const MACPORTS_TMUX_URL = 'https://ports.macports.org/port/tmux/';
const MICROSOFT_WSL_INSTALL_URL = 'https://learn.microsoft.com/en-us/windows/wsl/install';

function buildManualHints(platform: TmuxPlatform): TmuxInstallHint[] {
  if (platform === 'darwin') {
    return [
      {
        title: 'Homebrew',
        description: 'Recommended install path on macOS.',
        command: 'brew install tmux',
      },
      {
        title: 'MacPorts',
        description: 'Alternative macOS package manager.',
        command: 'sudo port install tmux',
      },
      {
        title: 'tmux guide',
        description: 'Official installation guide.',
        url: OFFICIAL_TMUX_INSTALL_URL,
      },
      { title: 'Homebrew', description: 'tmux package page.', url: HOMEBREW_TMUX_URL },
      { title: 'MacPorts', description: 'tmux port page.', url: MACPORTS_TMUX_URL },
    ];
  }

  if (platform === 'linux') {
    return [
      { title: 'APT', description: 'Debian/Ubuntu', command: 'sudo apt install tmux' },
      { title: 'DNF', description: 'Fedora/RHEL', command: 'sudo dnf install tmux' },
      { title: 'YUM', description: 'Older RHEL/CentOS', command: 'sudo yum install tmux' },
      { title: 'Zypper', description: 'openSUSE/SLES', command: 'sudo zypper install tmux' },
      { title: 'Pacman', description: 'Arch Linux', command: 'sudo pacman -S tmux' },
      {
        title: 'tmux guide',
        description: 'Official installation guide.',
        url: OFFICIAL_TMUX_INSTALL_URL,
      },
    ];
  }

  if (platform === 'win32') {
    return [
      {
        title: 'Install WSL',
        description: 'Install Windows Subsystem for Linux.',
        command: 'wsl --install --no-distribution',
      },
      {
        title: 'Install Ubuntu',
        description: 'Recommended WSL distro for optional tmux pane transport.',
        command: 'wsl --install -d Ubuntu --no-launch',
      },
      {
        title: 'Install tmux in WSL',
        description: 'Run this inside Ubuntu or another Linux distro.',
        command: 'sudo apt install tmux',
      },
      { title: 'tmux README', description: 'tmux upstream platform notes.', url: TMUX_README_URL },
      {
        title: 'tmux guide',
        description: 'Official installation guide.',
        url: OFFICIAL_TMUX_INSTALL_URL,
      },
      {
        title: 'Microsoft WSL',
        description: 'Official WSL installation docs.',
        url: MICROSOFT_WSL_INSTALL_URL,
      },
    ];
  }

  return [
    {
      title: 'tmux guide',
      description: 'Official installation guide.',
      url: OFFICIAL_TMUX_INSTALL_URL,
    },
  ];
}

export function buildTmuxAutoInstallCapability(
  input: BuildTmuxAutoInstallCapabilityInput
): TmuxAutoInstallCapability {
  const manualHints = buildManualHints(input.platform);
  const requiresAdmin =
    input.strategy === 'macports' ||
    input.strategy === 'apt' ||
    input.strategy === 'dnf' ||
    input.strategy === 'yum' ||
    input.strategy === 'zypper' ||
    input.strategy === 'pacman' ||
    input.strategy === 'wsl';

  if (input.platform === 'win32') {
    return {
      supported: false,
      strategy: 'wsl',
      packageManagerLabel: 'WSL',
      requiresTerminalInput: true,
      requiresAdmin: true,
      requiresRestart: true,
      mayOpenExternalWindow: true,
      reasonIfUnsupported: 'Windows WSL wizard is planned but not wired in this iteration yet.',
      manualHints,
    };
  }

  if (input.platform === 'linux' && input.immutableHost) {
    return {
      supported: false,
      strategy: 'manual',
      packageManagerLabel: input.packageManagerLabel ?? null,
      requiresTerminalInput: false,
      requiresAdmin: true,
      requiresRestart: false,
      reasonIfUnsupported: 'Immutable Linux hosts are manual-only in this iteration.',
      manualHints,
    };
  }

  if (input.strategy === 'manual' || input.strategy === 'unknown') {
    return {
      supported: false,
      strategy: input.strategy,
      packageManagerLabel: input.packageManagerLabel ?? null,
      requiresTerminalInput: false,
      requiresAdmin,
      requiresRestart: false,
      reasonIfUnsupported: 'No supported package manager was detected for automatic installation.',
      manualHints,
    };
  }

  if (requiresAdmin && !input.nonInteractivePrivilegeAvailable) {
    if (input.interactiveTerminalAvailable) {
      return {
        supported: true,
        strategy: input.strategy,
        packageManagerLabel: input.packageManagerLabel ?? null,
        requiresTerminalInput: true,
        requiresAdmin: true,
        requiresRestart: false,
        reasonIfUnsupported: null,
        manualHints,
      };
    }

    return {
      supported: false,
      strategy: input.strategy,
      packageManagerLabel: input.packageManagerLabel ?? null,
      requiresTerminalInput: true,
      requiresAdmin: true,
      requiresRestart: false,
      reasonIfUnsupported:
        'Administrator privileges are required. Run the manual install command in a terminal.',
      manualHints,
    };
  }

  return {
    supported: true,
    strategy: input.strategy,
    packageManagerLabel: input.packageManagerLabel ?? null,
    requiresTerminalInput: false,
    requiresAdmin,
    requiresRestart: false,
    mayOpenExternalWindow: false,
    reasonIfUnsupported: null,
    manualHints,
  };
}
