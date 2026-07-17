import path from 'node:path';

import type { RuntimeProviderCliCompanionDefinition } from '../types';

const KIRO_INSTALL_URL = 'https://cli.kiro.dev/install';
const KIRO_WINDOWS_INSTALL_URL = 'https://cli.kiro.dev/install.ps1';
const KIRO_DOWNLOADS_URL = 'https://kiro.dev/downloads/';
const MINIMUM_INSTALL_FREE_BYTES = 3 * 1024 * 1024 * 1024;

export function resolveKiroLinuxArchiveSuffix(arch: string, glibcVersion: string | null): string {
  const normalizedArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const [major = 0, minor = 0] = (glibcVersion ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const minimumMinor = normalizedArch === 'aarch64' ? 39 : 34;
  const glibcSupported = major > 2 || (major === 2 && minor >= minimumMinor);
  return `kirocli-${normalizedArch}-linux${glibcSupported ? '' : '-musl'}.zip`;
}

function getRuntimeGlibcVersion(): string | null {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const version = report?.header?.glibcVersionRuntime;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

async function fetchKiroPackageSize(
  platform: NodeJS.Platform,
  arch: string
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('https://prod.download.cli.kiro.dev/stable/latest/manifest.json', {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const manifest = (await response.json()) as {
      packages?: Array<{
        os?: string;
        architecture?: string;
        download?: string;
        size?: number;
      }>;
    };
    const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
    const linuxArchiveSuffix = resolveKiroLinuxArchiveSuffix(arch, getRuntimeGlibcVersion());
    const candidates = (manifest.packages ?? []).filter((entry) => {
      if (typeof entry.size !== 'number' || entry.size <= 0) return false;
      if (platform === 'darwin') return entry.download?.endsWith('Kiro CLI.dmg');
      if (platform === 'win32') {
        return (
          entry.os === 'windows' &&
          entry.architecture === architecture &&
          entry.download?.endsWith('.msi')
        );
      }
      return (
        entry.os === 'linux' &&
        entry.architecture === architecture &&
        entry.download?.endsWith(linuxArchiveSuffix)
      );
    });
    return candidates.reduce<number | null>(
      (largest, entry) => (largest === null || entry.size! > largest ? entry.size! : largest),
      null
    );
  } finally {
    clearTimeout(timer);
  }
}

function validateKiroInstallerScript(script: string, platform: NodeJS.Platform): void {
  const commonMarkers = ['Kiro CLI', 'prod.download.cli.kiro.dev', 'sha256'];
  const platformMarkers =
    platform === 'win32'
      ? ['$ErrorActionPreference', 'Get-FileHash', 'msiexec']
      : ['#!/bin/bash', 'download_and_verify', 'checksum'];
  if (![...commonMarkers, ...platformMarkers].every((marker) => script.includes(marker))) {
    throw new Error('Kiro changed its installer format; automatic installation was stopped safely');
  }
}

export const KIRO_CLI_COMPANION_DEFINITION: RuntimeProviderCliCompanionDefinition = {
  companionId: 'kiro-cli',
  displayName: 'Kiro CLI',
  verification: {
    providerId: 'kiro',
    modelId: 'kiro/auto',
  },
  supportsPlatform: (platform, arch) =>
    ['darwin', 'linux', 'win32'].includes(platform) &&
    ['x64', 'arm64'].includes(arch) &&
    (platform !== 'win32' || arch === 'x64'),
  installer: {
    url: (platform) => (platform === 'win32' ? KIRO_WINDOWS_INSTALL_URL : KIRO_INSTALL_URL),
    allowedFinalHosts: ['cli.kiro.dev'],
    scriptFileName: (platform) => (platform === 'win32' ? 'install.ps1' : 'install.sh'),
    command: (platform, scriptPath) =>
      platform === 'win32'
        ? {
            command: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          }
        : { command: '/bin/bash', args: [scriptPath] },
    validateScript: validateKiroInstallerScript,
    manualCommand: (platform) =>
      platform === 'win32'
        ? 'irm https://cli.kiro.dev/install.ps1 | iex'
        : 'curl -fsSL https://cli.kiro.dev/install | bash',
    manualUrl: KIRO_DOWNLOADS_URL,
    minimumFreeBytes: MINIMUM_INSTALL_FREE_BYTES,
    monitorDownload: true,
    // The official Windows script launches a signed MSI. Keep that native
    // installer tree behind a Node helper so a faulty MSI child cannot corrupt
    // or terminate the Electron host process.
    isolateFromHostOnWindows: true,
    packageDescription: 'signed Kiro CLI package',
    parseProgress: (text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes('downloading')) {
        return { percent: 42, detail: 'Downloading the signed Kiro CLI package...' };
      }
      if (normalized.includes('checksum') || normalized.includes('verifying')) {
        return { percent: 62, detail: 'Verifying the package checksum...' };
      }
      if (
        normalized.includes('installed successfully') ||
        normalized.includes('package installed')
      ) {
        return { percent: 76, detail: 'Kiro CLI package installed.' };
      }
      return null;
    },
    fetchPackageSize: fetchKiroPackageSize,
  },
  binary: {
    executableNames: (platform) =>
      platform === 'win32'
        ? ['kiro-cli.exe', 'kiro-cli.cmd', 'kiro-cli.bat', 'kiro-cli']
        : ['kiro-cli'],
    extraCandidates: (platform, homeDir) =>
      platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA ?? '', 'Kiro-Cli', 'kiro-cli.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Kiro-Cli', 'kiro-cli.exe'),
            path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Kiro-Cli', 'kiro-cli.exe'),
          ]
        : [
            path.join(homeDir, '.local', 'bin', 'kiro-cli'),
            '/usr/local/bin/kiro-cli',
            '/opt/homebrew/bin/kiro-cli',
            '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
          ],
    versionArgs: ['--version'],
  },
  auth: {
    loginArgs: ['login'],
    statusArgs: ['whoami', '--format', 'json'],
    isAuthenticated: (result) => result.exitCode === 0 && result.stdout.trim().length > 0,
  },
};
