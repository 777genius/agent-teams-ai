import { execFile } from 'node:child_process';

import { buildTmuxEffectiveAvailability } from '@features/tmux-installer/core/domain/policies/buildTmuxEffectiveAvailability';
import { TmuxInstallStrategyResolver } from '@features/tmux-installer/main/infrastructure/installer/TmuxInstallStrategyResolver';
import { TmuxPackageManagerResolver } from '@features/tmux-installer/main/infrastructure/platform/TmuxPackageManagerResolver';
import { TmuxPlatformResolver } from '@features/tmux-installer/main/infrastructure/platform/TmuxPlatformResolver';
import { TmuxWslService } from '@features/tmux-installer/main/infrastructure/wsl/TmuxWslService';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type {
  TmuxAutoInstallCapability,
  TmuxBinaryProbe,
  TmuxStatus,
  TmuxWslPreference,
  TmuxWslStatus,
} from '@features/tmux-installer/contracts';
import type { TmuxStatusSourcePort } from '@features/tmux-installer/core/application/ports/TmuxStatusSourcePort';

const STATUS_CACHE_TTL_MS = 10_000;

export class TmuxStatusSourceAdapter implements TmuxStatusSourcePort {
  readonly #platformResolver: TmuxPlatformResolver;
  readonly #packageManagerResolver: TmuxPackageManagerResolver;
  readonly #strategyResolver: TmuxInstallStrategyResolver;
  readonly #wslService: TmuxWslService;
  #cacheVersion = 0;
  #cachedStatus: { value: TmuxStatus; expiresAt: number } | null = null;
  #inFlightStatus: Promise<TmuxStatus> | null = null;

  constructor(
    platformResolver = new TmuxPlatformResolver(),
    packageManagerResolver = new TmuxPackageManagerResolver(),
    strategyResolver = new TmuxInstallStrategyResolver(platformResolver, packageManagerResolver),
    wslService = new TmuxWslService()
  ) {
    this.#platformResolver = platformResolver;
    this.#packageManagerResolver = packageManagerResolver;
    this.#strategyResolver = strategyResolver;
    this.#wslService = wslService;
  }

  async getStatus(): Promise<TmuxStatus> {
    const cachedStatus = this.#cachedStatus;
    if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
      return this.#cloneStatus(cachedStatus.value);
    }

    if (this.#inFlightStatus) {
      const status = await this.#inFlightStatus;
      return this.#cloneStatus(status);
    }

    const cacheVersion = this.#cacheVersion;
    const statusPromise = this.#probeStatus()
      .then((status) => {
        if (cacheVersion === this.#cacheVersion) {
          this.#cachedStatus = {
            value: status,
            expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
          };
        }
        return status;
      })
      .finally(() => {
        if (this.#inFlightStatus === statusPromise) {
          this.#inFlightStatus = null;
        }
      });

    this.#inFlightStatus = statusPromise;
    const status = await statusPromise;
    return this.#cloneStatus(status);
  }

  invalidateStatus(): void {
    this.#cacheVersion += 1;
    this.#cachedStatus = null;
    this.#inFlightStatus = null;
  }

  async #probeStatus(): Promise<TmuxStatus> {
    const resolvedPlatform = await this.#platformResolver.resolve();
    const checkedAt = new Date().toISOString();
    const env = buildEnrichedEnv();
    const plan = await this.#strategyResolver.resolve();

    const host = await this.#probeHostTmux(env, resolvedPlatform.platform);
    const wslProbe = resolvedPlatform.platform === 'win32' ? await this.#wslService.probe() : null;
    const effective = buildTmuxEffectiveAvailability({
      platform: resolvedPlatform.platform,
      nativeSupported: resolvedPlatform.nativeSupported,
      host,
      wsl: wslProbe?.status ?? null,
    });
    const autoInstall = this.#refineCapabilityForStatus(
      resolvedPlatform.platform,
      plan.capability,
      wslProbe?.status ?? null,
      wslProbe?.preference ?? null
    );

    return {
      platform: resolvedPlatform.platform,
      nativeSupported: resolvedPlatform.nativeSupported,
      checkedAt,
      host,
      effective: {
        ...effective,
        detail: this.#strategyResolver.buildStatusDetail({
          platform: resolvedPlatform.platform,
          effective,
          autoInstall,
          wsl: wslProbe?.status ?? null,
        }),
      },
      error: this.#resolveStatusError(host, wslProbe?.status ?? null, effective.available),
      autoInstall,
      wsl: wslProbe?.status ?? null,
      wslPreference: wslProbe?.preference ?? null,
    };
  }

  async #probeHostTmux(
    env: NodeJS.ProcessEnv,
    platform: TmuxStatus['platform']
  ): Promise<TmuxBinaryProbe> {
    try {
      const { stdout, stderr } = await this.#execFileAsync('tmux', ['-V'], env, 3_000);
      return {
        available: true,
        version: (stdout || stderr).trim() || null,
        binaryPath: await this.#packageManagerResolver.resolveTmuxBinary(env, platform),
        error: null,
      };
    } catch (error) {
      const missing =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code?: string }).code === 'ENOENT' ||
          (error as { code?: string }).code === 'ENOEXEC');
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: missing ? null : getErrorMessage(error),
      };
    }
  }

  #resolveStatusError(
    host: TmuxBinaryProbe,
    wslStatus: TmuxWslStatus | null,
    effectiveAvailable: boolean
  ): string | null {
    if (effectiveAvailable) {
      return null;
    }
    if (wslStatus) {
      return host.error ?? null;
    }
    return host.error ?? null;
  }

  #refineCapabilityForStatus(
    platform: TmuxStatus['platform'],
    capability: TmuxAutoInstallCapability,
    wslStatus: TmuxWslStatus | null,
    preference: TmuxWslPreference | null
  ): TmuxAutoInstallCapability {
    if (platform !== 'win32' || capability.strategy !== 'wsl') {
      return capability;
    }

    const manualHints = [...capability.manualHints];
    const distroName = preference?.preferredDistroName ?? wslStatus?.distroName ?? null;
    if (distroName && wslStatus?.innerPackageManager) {
      const command = this.#buildWslInstallCommand(distroName, wslStatus.innerPackageManager);
      if (
        !manualHints.some(
          (hint) => hint.command === command || hint.title === `Install tmux in ${distroName}`
        )
      ) {
        manualHints.unshift({
          title: `Install tmux in ${distroName}`,
          description: 'Run this from PowerShell or Windows Terminal.',
          command,
        });
      }
    }
    if (distroName && wslStatus && !wslStatus.distroBootstrapped) {
      manualHints.unshift({
        title: `Open ${distroName}`,
        description: 'Finish the first Linux user setup inside this WSL distro, then re-check.',
        command: `wsl -d ${distroName}`,
      });
    }

    return {
      ...capability,
      requiresRestart: Boolean(wslStatus?.rebootRequired) || capability.requiresRestart,
      reasonIfUnsupported: !wslStatus?.wslInstalled
        ? 'WSL is not installed yet. Install WSL first, then continue with tmux.'
        : !wslStatus.distroName
          ? (wslStatus.statusDetail ?? 'WSL is installed, but no Linux distro is configured yet.')
          : !wslStatus.distroBootstrapped
            ? `${wslStatus.distroName} still needs its first Linux user setup before tmux can be installed there.`
            : capability.reasonIfUnsupported,
      manualHints,
    };
  }

  #buildWslInstallCommand(
    distroName: string,
    strategy: NonNullable<TmuxWslStatus['innerPackageManager']>
  ): string {
    if (strategy === 'apt') {
      return `wsl -d ${distroName} -- sh -lc "sudo apt-get install -y tmux"`;
    }
    if (strategy === 'dnf') {
      return `wsl -d ${distroName} -- sh -lc "sudo dnf install -y tmux"`;
    }
    if (strategy === 'yum') {
      return `wsl -d ${distroName} -- sh -lc "sudo yum install -y tmux"`;
    }
    if (strategy === 'zypper') {
      return `wsl -d ${distroName} -- sh -lc "sudo zypper --non-interactive install tmux"`;
    }
    if (strategy === 'pacman') {
      return `wsl -d ${distroName} -- sh -lc "sudo pacman -S --noconfirm tmux"`;
    }
    return 'wsl -d <YourDistro> -- sh -lc "sudo apt-get install -y tmux"';
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
          reject(error instanceof Error ? error : new Error('tmux status probe failed'));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  #cloneStatus(status: TmuxStatus): TmuxStatus {
    return {
      ...status,
      host: { ...status.host },
      effective: { ...status.effective },
      autoInstall: {
        ...status.autoInstall,
        manualHints: status.autoInstall.manualHints.map((hint) => ({ ...hint })),
      },
      wsl: status.wsl ? { ...status.wsl } : status.wsl,
      wslPreference: status.wslPreference ? { ...status.wslPreference } : status.wslPreference,
    };
  }
}
