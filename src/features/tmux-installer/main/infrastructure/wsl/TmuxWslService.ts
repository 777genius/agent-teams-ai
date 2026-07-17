import { execFile } from 'node:child_process';
import path from 'node:path';

import { decodeInstallerProcessOutput } from '../runtime/decodeInstallerProcessOutput';

import { TmuxWslPreferenceStore } from './TmuxWslPreferenceStore';

import type {
  TmuxInstallStrategy,
  TmuxWslPreference,
  TmuxWslStatus,
} from '@features/tmux-installer/contracts';

interface ExecWslResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WslVerboseDistroEntry {
  name: string;
  isDefault: boolean;
  version: 1 | 2 | null;
}

interface WindowsOptionalFeatureState {
  FeatureName?: string | null;
  State?: string | null;
  RestartRequired?: string | boolean | null;
}

interface WindowsOptionalFeatureProbe {
  restartPending: boolean;
  hasConfiguredWslFeature: boolean;
}

interface WslDistroGroups {
  userDistros: string[];
  serviceDistros: string[];
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

type ExecFileLike = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
    encoding: 'buffer';
  },
  callback: ExecFileCallback
) => void;

export interface TmuxWslProbeResult {
  preference: TmuxWslPreference | null;
  status: TmuxWslStatus;
}

const MAX_BUFFER_BYTES = 1024 * 1024;
const WSL_NOT_AVAILABLE_DETAIL = 'WSL is not available on this Windows machine yet.';
const WINDOWS_WSL_FEATURE_NAMES = ['Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform'];
const POWERSHELL_FEATURE_QUERY = [
  '$features = Get-WindowsOptionalFeature -Online -FeatureName "Microsoft-Windows-Subsystem-Linux","VirtualMachinePlatform"',
  '$features | Select-Object FeatureName, State, RestartRequired | ConvertTo-Json -Compress',
].join('; ');
const SERVICE_WSL_DISTRO_EXACT_NAMES = new Set([
  'docker-desktop',
  'docker-desktop-data',
  'rancher-desktop',
  'rancher-desktop-data',
]);
const SERVICE_WSL_DISTRO_PREFIXES = ['podman-machine-'];

export class TmuxWslService {
  readonly #execFile: ExecFileLike;
  readonly #preferenceStore: TmuxWslPreferenceStore;

  constructor(
    execFileImpl: ExecFileLike = execFile as ExecFileLike,
    preferenceStore = new TmuxWslPreferenceStore()
  ) {
    this.#execFile = execFileImpl;
    this.#preferenceStore = preferenceStore;
  }

  async probe(): Promise<TmuxWslProbeResult> {
    const statusProbe = await this.#run(['--status'], 4_000);
    const distroListProbe = await this.#run(['--list', '--quiet'], 4_000);
    const featureProbe = await this.#queryWindowsOptionalFeatures();
    const persistedPreferredDistro = await this.#preferenceStore.getPreferredDistro();
    const wslInstalled =
      statusProbe.exitCode === 0 ||
      distroListProbe.exitCode === 0 ||
      featureProbe?.hasConfiguredWslFeature === true;
    const rebootRequired =
      featureProbe?.restartPending === true ||
      this.#looksLikeRestartRequired(`${statusProbe.stdout}\n${statusProbe.stderr}`);

    if (!wslInstalled) {
      if (persistedPreferredDistro) {
        await this.#preferenceStore.clearPreferredDistro();
      }
      return {
        preference: null,
        status: {
          wslInstalled: false,
          rebootRequired,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: this.#firstNonEmpty(
            statusProbe.stderr,
            statusProbe.stdout,
            WSL_NOT_AVAILABLE_DETAIL
          ),
        },
      };
    }

    const listedDistros = this.#parseWslDistros(distroListProbe.stdout);
    const serviceDistros = listedDistros.filter((distro) => this.#isInternalWslDistro(distro));
    const distros = listedDistros.filter((distro) => !this.#isInternalWslDistro(distro));
    if (distros.length === 0) {
      if (persistedPreferredDistro) {
        await this.#preferenceStore.clearPreferredDistro();
      }
      const hasOnlyServiceDistros = serviceDistros.length > 0;
      return {
        preference: null,
        status: {
          wslInstalled: true,
          rebootRequired,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: rebootRequired
            ? 'WSL was installed, but Windows still needs a restart before a Linux distro can be configured.'
            : hasOnlyServiceDistros
              ? `WSL has only service distributions (${serviceDistros.join(', ')}). Install a Linux distribution such as Ubuntu for teammate runtime support.`
              : 'WSL is available, but no Linux distribution is installed yet.',
        },
      };
    }

    const distroGroups = this.#groupWslDistros(distros);
    if (distroGroups.userDistros.length === 0) {
      if (persistedPreferredDistro) {
        await this.#preferenceStore.clearPreferredDistro();
      }
      return {
        preference: null,
        status: {
          wslInstalled: true,
          rebootRequired,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: this.#buildNoUserDistroDetail({
            rebootRequired,
            serviceDistros: distroGroups.serviceDistros,
          }),
        },
      };
    }

    const verboseProbe = await this.#run(['--list', '--verbose'], 4_000);
    const verboseEntries = this.#parseVerboseDistroEntries(verboseProbe.stdout, distros);
    const preferredDistro = this.#resolvePreferredDistro({
      userDistros: distroGroups.userDistros,
      verboseEntries,
      persistedPreferredDistro,
    });
    const usingPersistedPreference =
      Boolean(persistedPreferredDistro) && preferredDistro === persistedPreferredDistro;
    if (persistedPreferredDistro && preferredDistro !== persistedPreferredDistro) {
      await this.#preferenceStore.clearPreferredDistro();
    }
    const preferredVersion =
      verboseEntries.find((entry) => entry.name === preferredDistro)?.version ?? null;

    if (!preferredDistro) {
      return {
        preference: {
          preferredDistroName: null,
          source: null,
        },
        status: {
          wslInstalled: true,
          rebootRequired,
          distroName: null,
          distroVersion: null,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail:
            distroGroups.userDistros.length > 1
              ? 'WSL has multiple user Linux distributions, but no default or saved distro target is configured yet.'
              : 'WSL is available, but the app could not determine which Linux distribution to target.',
        },
      };
    }

    const preferredEntry = verboseEntries.find((entry) => entry.name === preferredDistro);
    const preference: TmuxWslPreference = {
      preferredDistroName: preferredDistro,
      source: usingPersistedPreference
        ? 'persisted'
        : preferredEntry?.isDefault
          ? 'default'
          : 'manual',
    };

    const bootstrapProbe = await this.#run(
      ['-d', preferredDistro, '--', 'sh', '-lc', 'printf ready'],
      5_000
    );
    const distroBootstrapped = bootstrapProbe.exitCode === 0;
    if (!distroBootstrapped) {
      return {
        preference,
        status: {
          wslInstalled: true,
          rebootRequired,
          distroName: preferredDistro,
          distroVersion: preferredVersion,
          distroBootstrapped: false,
          innerPackageManager: null,
          tmuxAvailableInsideWsl: false,
          tmuxVersion: null,
          tmuxBinaryPath: null,
          statusDetail: this.#firstNonEmpty(
            bootstrapProbe.stderr,
            bootstrapProbe.stdout,
            `${preferredDistro} is installed in WSL, but its first Linux user setup is not finished yet. Open it once, complete the setup, then re-check.`
          ),
        },
      };
    }

    const innerPackageManager = await this.#resolveInnerPackageManager(preferredDistro);
    const tmuxProbe = await this.#run(
      [
        '-d',
        preferredDistro,
        '--',
        'sh',
        '-lc',
        'command -v tmux >/dev/null 2>&1 && { tmux -V; printf "\\n"; command -v tmux; }',
      ],
      5_000
    );
    const tmuxLines = tmuxProbe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      preference,
      status: {
        wslInstalled: true,
        rebootRequired,
        distroName: preferredDistro,
        distroVersion: preferredVersion,
        distroBootstrapped: true,
        innerPackageManager,
        tmuxAvailableInsideWsl: tmuxProbe.exitCode === 0,
        tmuxVersion: tmuxProbe.exitCode === 0 ? (tmuxLines[0] ?? null) : null,
        tmuxBinaryPath: tmuxProbe.exitCode === 0 ? (tmuxLines[1] ?? null) : null,
        statusDetail:
          tmuxProbe.exitCode === 0
            ? `tmux is available inside ${preferredDistro} on Windows through WSL.`
            : `tmux is not installed inside the ${preferredDistro} WSL distro yet.`,
      },
    };
  }

  async execTmux(
    args: string[],
    preferredDistroName?: string | null,
    timeout = 5_000
  ): Promise<ExecWslResult> {
    const distroName = preferredDistroName ?? (await this.probe()).preference?.preferredDistroName;
    if (!distroName) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'No WSL distribution is available for tmux.',
      };
    }

    return this.#run(['-d', distroName, '-e', 'tmux', ...args], timeout);
  }

  async execInPreferredDistro(
    args: string[],
    preferredDistroName?: string | null,
    timeout = 5_000
  ): Promise<ExecWslResult> {
    const distroName = preferredDistroName ?? (await this.probe()).preference?.preferredDistroName;
    if (!distroName) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'No WSL distribution is available.',
      };
    }

    return this.#run(['-d', distroName, '-e', ...args], timeout);
  }

  getPersistedPreferredDistroSync(): string | null {
    return this.#preferenceStore.getPreferredDistroSync();
  }

  async persistPreferredDistro(preferredDistroName: string | null): Promise<void> {
    if (!preferredDistroName?.trim()) {
      await this.#preferenceStore.clearPreferredDistro();
      return;
    }
    await this.#preferenceStore.setPreferredDistro(preferredDistroName);
  }

  async #resolveInnerPackageManager(distro: string): Promise<TmuxInstallStrategy | null> {
    const distroIdProbe = await this.#run(
      ['-d', distro, '--', 'sh', '-lc', '. /etc/os-release >/dev/null 2>&1 && printf %s "$ID"'],
      4_000
    );
    const distroId = distroIdProbe.stdout.trim().toLowerCase();
    if (distroId === 'arch') {
      return 'pacman';
    }
    if (distroId === 'fedora') {
      return 'dnf';
    }
    if (
      distroId === 'ubuntu' ||
      distroId === 'debian' ||
      distroId === 'pop' ||
      distroId === 'linuxmint' ||
      distroId === 'kali'
    ) {
      return 'apt';
    }
    if (distroId === 'opensuse-tumbleweed' || distroId === 'opensuse-leap' || distroId === 'sles') {
      return 'zypper';
    }

    const candidateChecks: { binary: string; strategy: TmuxInstallStrategy }[] = [
      { binary: 'apt-get', strategy: 'apt' },
      { binary: 'dnf', strategy: 'dnf' },
      { binary: 'yum', strategy: 'yum' },
      { binary: 'zypper', strategy: 'zypper' },
      { binary: 'pacman', strategy: 'pacman' },
    ];

    for (const candidate of candidateChecks) {
      const probe = await this.#run(
        ['-d', distro, '--', 'sh', '-lc', `command -v ${candidate.binary} >/dev/null 2>&1`],
        3_000
      );
      if (probe.exitCode === 0) {
        return candidate.strategy;
      }
    }

    return null;
  }

  async #run(args: string[], timeout: number): Promise<ExecWslResult> {
    const candidates = this.#getExecutableCandidates();
    let lastFailure: ExecWslResult | null = null;

    for (const executable of candidates) {
      const result = await this.#exec(executable, args, timeout);
      if (result === null) {
        continue;
      }
      lastFailure = result;
      if (result.exitCode === 0) {
        return result;
      }
      if (result.exitCode !== 0) {
        return result;
      }
    }

    return (
      lastFailure ?? {
        exitCode: 1,
        stdout: '',
        stderr: WSL_NOT_AVAILABLE_DETAIL,
      }
    );
  }

  async #exec(executable: string, args: string[], timeout: number): Promise<ExecWslResult | null> {
    return new Promise((resolve) => {
      this.#execFile(
        executable,
        args,
        {
          timeout,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const errorCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          if (errorCode === 'ENOENT') {
            resolve(null);
            return;
          }
          resolve({
            exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
            stdout: this.#decodeOutput(stdout),
            stderr: this.#decodeOutput(stderr) || (error instanceof Error ? error.message : ''),
          });
        }
      );
    });
  }

  #getExecutableCandidates(): string[] {
    const candidates = new Set<string>();
    const windir = process.env.WINDIR;
    if (windir) {
      candidates.add(path.join(windir, 'System32', 'wsl.exe'));
      candidates.add(path.join(windir, 'Sysnative', 'wsl.exe'));
    }
    candidates.add('wsl.exe');
    return [...candidates];
  }

  #decodeOutput(output: string | Buffer): string {
    return decodeInstallerProcessOutput(output);
  }

  #parseWslDistros(stdout: string): string[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .map((line) => line.replace(/^\*\s*/, '').trim())
      .filter(Boolean);
  }

  #isInternalWslDistro(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === 'docker-desktop' || normalized === 'docker-desktop-data';
  }

  #parseVerboseDistroEntries(stdout: string, distros: string[]): WslVerboseDistroEntry[] {
    const sortedDistros = [...distros].sort((left, right) => right.length - left.length);
    const entries: WslVerboseDistroEntry[] = [];

    for (const rawLine of stdout.split(/\r?\n/)) {
      let line = rawLine.replace(/\0/g, '').trim();
      if (!line) {
        continue;
      }

      const isDefault = line.startsWith('*');
      if (isDefault) {
        line = line.slice(1).trim();
      }

      const matchedName = sortedDistros.find((distro) => line.startsWith(distro));
      if (!matchedName) {
        continue;
      }

      const lineTokens = line.split(/\s+/);
      const versionToken = lineTokens[lineTokens.length - 1];
      const version = versionToken === '1' ? 1 : versionToken === '2' ? 2 : null;
      entries.push({ name: matchedName, isDefault, version });
    }

    return entries;
  }

  #groupWslDistros(distros: string[]): WslDistroGroups {
    const userDistros: string[] = [];
    const serviceDistros: string[] = [];

    for (const distro of distros) {
      if (this.#isServiceWslDistro(distro)) {
        serviceDistros.push(distro);
      } else {
        userDistros.push(distro);
      }
    }

    return { userDistros, serviceDistros };
  }

  #isServiceWslDistro(distro: string): boolean {
    const normalized = distro.trim().toLowerCase();
    return (
      SERVICE_WSL_DISTRO_EXACT_NAMES.has(normalized) ||
      SERVICE_WSL_DISTRO_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  }

  #resolvePreferredDistro(input: {
    userDistros: string[];
    verboseEntries: WslVerboseDistroEntry[];
    persistedPreferredDistro: string | null;
  }): string | null {
    if (
      input.persistedPreferredDistro &&
      input.userDistros.includes(input.persistedPreferredDistro)
    ) {
      return input.persistedPreferredDistro;
    }

    const defaultDistro =
      input.verboseEntries.find(
        (entry) => entry.isDefault && input.userDistros.includes(entry.name)
      )?.name ?? null;
    if (defaultDistro) {
      return defaultDistro;
    }

    if (input.userDistros.length === 1) {
      return input.userDistros[0] ?? null;
    }

    return this.#findRecommendedUserDistro(input.userDistros);
  }

  #findRecommendedUserDistro(userDistros: string[]): string | null {
    const exactPriority = ['ubuntu', 'ubuntu-24.04', 'ubuntu-22.04', 'debian'];
    for (const preferredName of exactPriority) {
      const matched = userDistros.find((distro) => distro.toLowerCase() === preferredName);
      if (matched) {
        return matched;
      }
    }

    return userDistros.find((distro) => this.#looksLikeVersionedUbuntuDistro(distro)) ?? null;
  }

  #looksLikeVersionedUbuntuDistro(distro: string): boolean {
    const normalized = distro.toLowerCase();
    if (!normalized.startsWith('ubuntu-')) {
      return false;
    }

    const versionSuffix = normalized.slice('ubuntu-'.length);
    return (
      versionSuffix.length > 0 &&
      [...versionSuffix].every((character) => {
        return (character >= '0' && character <= '9') || character === '.';
      })
    );
  }

  #buildNoUserDistroDetail(input: { rebootRequired: boolean; serviceDistros: string[] }): string {
    if (input.rebootRequired) {
      return 'WSL was installed, but Windows still needs a restart before a Linux distro can be configured.';
    }

    if (input.serviceDistros.length > 0) {
      return `WSL is available, but only service distributions are installed (${input.serviceDistros.join(', ')}). Install Ubuntu or another user Linux distro before setting up tmux.`;
    }

    return 'WSL is available, but no Linux distribution is installed yet.';
  }

  #looksLikeRestartRequired(output: string): boolean {
    const lowered = output.toLowerCase();
    return (
      lowered.includes('restart') ||
      lowered.includes('reboot') ||
      lowered.includes('перезагруз') ||
      lowered.includes('требуется перезагрузка')
    );
  }

  async #queryWindowsOptionalFeatures(): Promise<WindowsOptionalFeatureProbe | null> {
    const result = await this.#execPowerShell(
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_FEATURE_QUERY],
      6_000
    );
    if (result?.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.stdout) as
        | WindowsOptionalFeatureState
        | WindowsOptionalFeatureState[];
      const features = Array.isArray(parsed) ? parsed : [parsed];
      const relevantFeatures = features.filter((feature) =>
        WINDOWS_WSL_FEATURE_NAMES.includes(feature.FeatureName ?? '')
      );
      if (relevantFeatures.length === 0) {
        return null;
      }

      return {
        restartPending: relevantFeatures.some((feature) =>
          String(feature.State ?? '')
            .toLowerCase()
            .includes('pending')
        ),
        hasConfiguredWslFeature: relevantFeatures.some((feature) => {
          const state = String(feature.State ?? '').toLowerCase();
          return state.length > 0 && state !== 'disabled' && state !== 'disabledwithpayloadremoved';
        }),
      };
    } catch {
      return null;
    }
  }

  async #execPowerShell(args: string[], timeout: number): Promise<ExecWslResult | null> {
    return new Promise((resolve) => {
      this.#execFile(
        'powershell.exe',
        args,
        {
          timeout,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const errorCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          if (errorCode === 'ENOENT') {
            resolve(null);
            return;
          }
          resolve({
            exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
            stdout: this.#decodeOutput(stdout),
            stderr: this.#decodeOutput(stderr) || (error instanceof Error ? error.message : ''),
          });
        }
      );
    });
  }

  #firstNonEmpty(...values: (string | null | undefined)[]): string {
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return WSL_NOT_AVAILABLE_DETAIL;
  }
}
