import { promises as fsp } from 'node:fs';

import type { TmuxPlatform } from '@features/tmux-installer/contracts';

export interface LinuxPlatformInfo {
  distroId: string | null;
  immutableHost: boolean;
}

export interface ResolvedTmuxPlatform {
  platform: TmuxPlatform;
  nativeSupported: boolean;
  linux: LinuxPlatformInfo | null;
}

export class TmuxPlatformResolver {
  async resolve(): Promise<ResolvedTmuxPlatform> {
    const platform = this.#mapPlatform(process.platform);
    if (platform !== 'linux') {
      return {
        platform,
        nativeSupported: platform === 'darwin',
        linux: null,
      };
    }

    return {
      platform,
      nativeSupported: true,
      linux: await this.#resolveLinuxInfo(),
    };
  }

  #mapPlatform(platform: NodeJS.Platform): TmuxPlatform {
    if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
      return platform;
    }
    return 'unknown';
  }

  async #resolveLinuxInfo(): Promise<LinuxPlatformInfo> {
    let distroId: string | null = null;
    try {
      const content = await fsp.readFile('/etc/os-release', 'utf8');
      distroId =
        content
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith('ID='))
          ?.slice(3)
          .replace(/(^"|"$)/g, '') ?? null;
    } catch {
      distroId = null;
    }

    const immutableHost =
      (await this.#exists('/run/ostree-booted')) ||
      (await this.#exists('/usr/bin/rpm-ostree')) ||
      distroId === 'opensuse-microos';

    return { distroId, immutableHost };
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
