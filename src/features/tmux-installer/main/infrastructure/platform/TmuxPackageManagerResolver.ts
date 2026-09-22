import { execFile } from 'node:child_process';

import type { LinuxPlatformInfo } from './TmuxPlatformResolver';
import type { TmuxInstallStrategy } from '@features/tmux-installer/contracts';

interface ResolveBinaryResult {
  path: string | null;
  label: string | null;
  strategy: TmuxInstallStrategy;
}

export class TmuxPackageManagerResolver {
  async resolveForMac(env: NodeJS.ProcessEnv): Promise<ResolveBinaryResult> {
    const brewPath = await this.#resolveBinary('brew', env);
    if (brewPath) {
      return { path: brewPath, label: 'Homebrew', strategy: 'homebrew' };
    }

    const portPath = await this.#resolveBinary('port', env);
    if (portPath) {
      return { path: portPath, label: 'MacPorts', strategy: 'macports' };
    }

    return { path: null, label: null, strategy: 'manual' };
  }

  async resolveForLinux(
    env: NodeJS.ProcessEnv,
    linuxInfo: LinuxPlatformInfo | null
  ): Promise<ResolveBinaryResult> {
    const preferredStrategies: {
      binary: string;
      label: string;
      strategy: TmuxInstallStrategy;
    }[] =
      linuxInfo?.distroId === 'arch'
        ? [{ binary: 'pacman', label: 'Pacman', strategy: 'pacman' }]
        : linuxInfo?.distroId === 'fedora'
          ? [{ binary: 'dnf', label: 'DNF', strategy: 'dnf' }]
          : linuxInfo?.distroId === 'opensuse-tumbleweed' ||
              linuxInfo?.distroId === 'opensuse-leap' ||
              linuxInfo?.distroId === 'sles'
            ? [{ binary: 'zypper', label: 'Zypper', strategy: 'zypper' }]
            : [{ binary: 'apt-get', label: 'APT', strategy: 'apt' }];

    const candidates = [
      ...preferredStrategies,
      { binary: 'apt-get', label: 'APT', strategy: 'apt' as const },
      { binary: 'dnf', label: 'DNF', strategy: 'dnf' as const },
      { binary: 'yum', label: 'YUM', strategy: 'yum' as const },
      { binary: 'zypper', label: 'Zypper', strategy: 'zypper' as const },
      { binary: 'pacman', label: 'Pacman', strategy: 'pacman' as const },
    ];

    for (const candidate of candidates) {
      const binaryPath = await this.#resolveBinary(candidate.binary, env);
      if (binaryPath) {
        return { path: binaryPath, label: candidate.label, strategy: candidate.strategy };
      }
    }

    return { path: null, label: null, strategy: 'manual' };
  }

  async resolveTmuxBinary(
    env: NodeJS.ProcessEnv,
    platform: 'darwin' | 'linux' | 'win32' | 'unknown'
  ): Promise<string | null> {
    const locator = platform === 'win32' ? 'where' : 'which';
    return this.#resolveBinaryWithLocator(locator, 'tmux', env);
  }

  async canRunNonInteractiveSudo(env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      await this.#execFileAsync('sudo', ['-n', 'true'], env, 2_000);
      return true;
    } catch {
      return false;
    }
  }

  async #resolveBinary(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    return this.#resolveBinaryWithLocator(
      process.platform === 'win32' ? 'where' : 'which',
      command,
      env
    );
  }

  async #resolveBinaryWithLocator(
    locator: string,
    command: string,
    env: NodeJS.ProcessEnv
  ): Promise<string | null> {
    try {
      const { stdout } = await this.#execFileAsync(locator, [command], env, 2_000);
      const firstLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return firstLine ?? null;
    } catch {
      return null;
    }
  }

  #execFileAsync(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { env, timeout }, (error, stdout, stderr) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(`Failed to run locator ${command}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}
