import { buildTmuxAutoInstallCapability } from '@features/tmux-installer/core/domain/policies/buildTmuxAutoInstallCapability';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getShellPreferredHome, resolveInteractiveShellEnv } from '@main/utils/shellEnv';

import { TmuxPackageManagerResolver } from '../platform/TmuxPackageManagerResolver';
import { TmuxPlatformResolver } from '../platform/TmuxPlatformResolver';
import { TmuxWslService } from '../wsl/TmuxWslService';

import { TmuxInstallTerminalSession } from './TmuxInstallTerminalSession';

import type {
  TmuxAutoInstallCapability,
  TmuxEffectiveAvailability,
  TmuxInstallStrategy,
  TmuxWslStatus,
} from '@features/tmux-installer/contracts';

export interface TmuxInstallPlan {
  capability: TmuxAutoInstallCapability;
  command: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    requiresPty: boolean;
    displayCommand?: string | null;
  } | null;
  retryWithUpdateCommand: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    requiresPty: boolean;
    displayCommand?: string | null;
  } | null;
}

export class TmuxInstallStrategyResolver {
  readonly #platformResolver: TmuxPlatformResolver;
  readonly #packageManagerResolver: TmuxPackageManagerResolver;
  readonly #wslService: TmuxWslService;

  constructor(
    platformResolver = new TmuxPlatformResolver(),
    packageManagerResolver = new TmuxPackageManagerResolver(),
    wslService = new TmuxWslService()
  ) {
    this.#platformResolver = platformResolver;
    this.#packageManagerResolver = packageManagerResolver;
    this.#wslService = wslService;
  }

  async resolve(): Promise<TmuxInstallPlan> {
    await resolveInteractiveShellEnv();
    const env = buildEnrichedEnv();
    const cwd = getShellPreferredHome();
    const resolvedPlatform = await this.#platformResolver.resolve();

    if (resolvedPlatform.platform === 'darwin') {
      const manager = await this.#packageManagerResolver.resolveForMac(env);
      const canRunNonInteractiveSudo =
        manager.strategy === 'macports'
          ? await this.#packageManagerResolver.canRunNonInteractiveSudo(env)
          : true;
      const interactiveTerminalAvailable = TmuxInstallTerminalSession.isSupported();
      const capability = buildTmuxAutoInstallCapability({
        platform: resolvedPlatform.platform,
        strategy: manager.strategy,
        packageManagerLabel: manager.label,
        nonInteractivePrivilegeAvailable: canRunNonInteractiveSudo,
        interactiveTerminalAvailable,
      });
      return {
        capability,
        command: this.#buildCommand(manager.strategy, env, cwd, {
          requiresPty: manager.strategy === 'macports' && !canRunNonInteractiveSudo,
        }),
        retryWithUpdateCommand: null,
      };
    }

    if (resolvedPlatform.platform === 'linux') {
      const manager = await this.#packageManagerResolver.resolveForLinux(
        env,
        resolvedPlatform.linux
      );
      const canRunNonInteractiveSudo =
        manager.strategy === 'manual'
          ? false
          : await this.#packageManagerResolver.canRunNonInteractiveSudo(env);
      const interactiveTerminalAvailable = TmuxInstallTerminalSession.isSupported();
      const capability = buildTmuxAutoInstallCapability({
        platform: resolvedPlatform.platform,
        strategy: manager.strategy,
        packageManagerLabel: manager.label,
        immutableHost: resolvedPlatform.linux?.immutableHost ?? false,
        nonInteractivePrivilegeAvailable: canRunNonInteractiveSudo,
        interactiveTerminalAvailable,
      });
      return {
        capability,
        command: this.#buildCommand(manager.strategy, env, cwd, {
          requiresPty: manager.strategy !== 'manual' && !canRunNonInteractiveSudo,
        }),
        retryWithUpdateCommand:
          manager.strategy === 'apt' && canRunNonInteractiveSudo
            ? {
                command: 'sudo',
                args: ['-n', 'apt-get', 'update'],
                env,
                cwd,
                requiresPty: false,
              }
            : null,
      };
    }

    if (resolvedPlatform.platform === 'win32') {
      const wslProbe = await this.#wslService.probe();
      const interactiveTerminalAvailable = TmuxInstallTerminalSession.isSupported();
      if (
        wslProbe.status.wslInstalled &&
        !wslProbe.status.rebootRequired &&
        wslProbe.status.distroBootstrapped &&
        wslProbe.status.distroName &&
        wslProbe.status.innerPackageManager &&
        interactiveTerminalAvailable
      ) {
        return {
          capability: this.#buildWindowsCapability(wslProbe.status, interactiveTerminalAvailable),
          command: this.#buildWslCommand(
            wslProbe.status.distroName,
            wslProbe.status.innerPackageManager,
            env,
            cwd
          ),
          retryWithUpdateCommand: null,
        };
      }

      return {
        capability: this.#buildWindowsCapability(wslProbe.status, interactiveTerminalAvailable),
        command: null,
        retryWithUpdateCommand: null,
      };
    }

    const capability = buildTmuxAutoInstallCapability({
      platform: resolvedPlatform.platform,
      strategy: 'manual',
      packageManagerLabel: null,
      nonInteractivePrivilegeAvailable: false,
    });
    return {
      capability,
      command: null,
      retryWithUpdateCommand: null,
    };
  }

  buildStatusDetail(input: {
    platform: 'darwin' | 'linux' | 'win32' | 'unknown';
    effective: TmuxEffectiveAvailability;
    autoInstall: TmuxAutoInstallCapability;
    wsl: TmuxWslStatus | null;
  }): string | null {
    if (input.effective.detail) {
      return input.effective.detail;
    }

    if (input.effective.available) {
      return input.effective.location === 'wsl'
        ? 'tmux is available inside WSL on Windows.'
        : 'tmux is available.';
    }

    if (input.platform === 'darwin') {
      return 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.';
    }
    if (input.platform === 'linux') {
      return 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.';
    }
    if (input.platform === 'win32') {
      return (
        input.wsl?.statusDetail ??
        'You can keep using the app without tmux. On Windows, tmux setup uses WSL and is only needed for optional pane transport.'
      );
    }
    return 'You can keep using the app without tmux. Install tmux only if you want optional pane transport.';
  }

  #buildCommand(
    strategy: TmuxInstallStrategy,
    env: NodeJS.ProcessEnv,
    cwd: string,
    options: { requiresPty: boolean }
  ): TmuxInstallPlan['command'] {
    if (strategy === 'homebrew') {
      return { command: 'brew', args: ['install', 'tmux'], env, cwd, requiresPty: false };
    }
    if (strategy === 'macports') {
      return {
        command: 'sudo',
        args: options.requiresPty ? ['port', 'install', 'tmux'] : ['-n', 'port', 'install', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    if (strategy === 'apt') {
      return {
        command: 'sudo',
        args: options.requiresPty
          ? ['apt-get', 'install', '-y', 'tmux']
          : ['-n', 'apt-get', 'install', '-y', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    if (strategy === 'dnf') {
      return {
        command: 'sudo',
        args: options.requiresPty
          ? ['dnf', 'install', '-y', 'tmux']
          : ['-n', 'dnf', 'install', '-y', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    if (strategy === 'yum') {
      return {
        command: 'sudo',
        args: options.requiresPty
          ? ['yum', 'install', '-y', 'tmux']
          : ['-n', 'yum', 'install', '-y', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    if (strategy === 'zypper') {
      return {
        command: 'sudo',
        args: options.requiresPty
          ? ['zypper', '--non-interactive', 'install', 'tmux']
          : ['-n', 'zypper', '--non-interactive', 'install', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    if (strategy === 'pacman') {
      return {
        command: 'sudo',
        args: options.requiresPty
          ? ['pacman', '-S', '--noconfirm', 'tmux']
          : ['-n', 'pacman', '-S', '--noconfirm', 'tmux'],
        env,
        cwd,
        requiresPty: options.requiresPty,
      };
    }
    return null;
  }

  #buildWslCommand(
    distroName: string,
    strategy: TmuxInstallStrategy,
    env: NodeJS.ProcessEnv,
    cwd: string
  ): TmuxInstallPlan['command'] {
    return {
      command: 'wsl.exe',
      args: ['-d', distroName, '--', 'sh', '-lc', this.#buildWslInstallShellCommand(strategy)],
      env,
      cwd,
      requiresPty: true,
      displayCommand: this.#buildWslDisplayCommand(distroName, strategy),
    };
  }

  #buildWslInstallShellCommand(strategy: TmuxInstallStrategy): string {
    if (strategy === 'apt') {
      return 'sudo apt-get install -y tmux';
    }
    if (strategy === 'dnf') {
      return 'sudo dnf install -y tmux';
    }
    if (strategy === 'yum') {
      return 'sudo yum install -y tmux';
    }
    if (strategy === 'zypper') {
      return 'sudo zypper --non-interactive install tmux';
    }
    if (strategy === 'pacman') {
      return 'sudo pacman -S --noconfirm tmux';
    }
    return 'sudo apt-get install -y tmux';
  }

  #buildWslDisplayCommand(distroName: string, strategy: TmuxInstallStrategy): string {
    return `wsl -d ${distroName} -- sh -lc "${this.#buildWslInstallShellCommand(strategy)}"`;
  }

  #buildWindowsCapability(
    status: TmuxWslStatus,
    interactiveTerminalAvailable: boolean
  ): TmuxAutoInstallCapability {
    const baseCapability = buildTmuxAutoInstallCapability({
      platform: 'win32',
      strategy: 'wsl',
      packageManagerLabel: 'WSL',
      nonInteractivePrivilegeAvailable: false,
      interactiveTerminalAvailable,
    });
    const manualHints = [...baseCapability.manualHints];

    if (status.distroName && status.innerPackageManager) {
      this.#prependUniqueHint(manualHints, {
        title: `Install tmux in ${status.distroName}`,
        description:
          'The app can run this inside WSL and forward Linux terminal input if sudo prompts for the distro password.',
        command: this.#buildWslDisplayCommand(status.distroName, status.innerPackageManager),
      });
    }

    if (status.wslInstalled && !status.distroName) {
      this.#prependUniqueHint(manualHints, {
        title: 'Install Ubuntu',
        description: 'Recommended WSL distro for optional tmux pane transport.',
        command: 'wsl --install -d Ubuntu --no-launch',
      });
    }

    if (!status.wslInstalled) {
      return {
        ...baseCapability,
        supported: true,
        requiresAdmin: true,
        requiresRestart: false,
        requiresTerminalInput: false,
        mayOpenExternalWindow: true,
        reasonIfUnsupported: null,
        manualHints,
      };
    }

    if (status.rebootRequired) {
      return {
        ...baseCapability,
        supported: false,
        requiresAdmin: false,
        requiresRestart: true,
        mayOpenExternalWindow: false,
        reasonIfUnsupported:
          'WSL was installed, but Windows still needs a restart before tmux setup can continue.',
        manualHints,
      };
    }

    if (!status.distroName) {
      return {
        ...baseCapability,
        supported: true,
        requiresAdmin: false,
        requiresRestart: false,
        requiresTerminalInput: false,
        mayOpenExternalWindow: true,
        reasonIfUnsupported: null,
        manualHints,
      };
    }

    if (!status.distroBootstrapped) {
      return {
        ...baseCapability,
        supported: false,
        requiresAdmin: false,
        requiresRestart: false,
        requiresTerminalInput: false,
        mayOpenExternalWindow: true,
        reasonIfUnsupported: `${status.distroName} still needs its first Linux user setup before tmux can be installed there.`,
        manualHints,
      };
    }

    if (!status.innerPackageManager) {
      return {
        ...baseCapability,
        supported: false,
        requiresAdmin: false,
        requiresRestart: false,
        requiresTerminalInput: false,
        mayOpenExternalWindow: false,
        reasonIfUnsupported: `${status.distroName} is available in WSL, but the app could not determine its package manager.`,
        manualHints,
      };
    }

    if (!interactiveTerminalAvailable) {
      return {
        ...baseCapability,
        supported: false,
        requiresAdmin: false,
        requiresRestart: false,
        requiresTerminalInput: true,
        mayOpenExternalWindow: false,
        reasonIfUnsupported:
          'Interactive installer terminal support is unavailable in this build, so WSL tmux install must be finished manually.',
        manualHints,
      };
    }

    return {
      ...baseCapability,
      supported: true,
      requiresAdmin: false,
      requiresRestart: false,
      requiresTerminalInput: true,
      mayOpenExternalWindow: false,
      reasonIfUnsupported: null,
      manualHints,
    };
  }

  #prependUniqueHint(
    manualHints: TmuxAutoInstallCapability['manualHints'],
    nextHint: TmuxAutoInstallCapability['manualHints'][number]
  ): void {
    if (
      manualHints.some(
        (hint) =>
          hint.title === nextHint.title ||
          (hint.command && nextHint.command && hint.command === nextHint.command)
      )
    ) {
      return;
    }
    manualHints.unshift(nextHint);
  }
}
