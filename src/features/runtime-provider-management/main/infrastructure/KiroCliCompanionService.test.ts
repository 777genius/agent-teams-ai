import { describe, expect, it, vi } from 'vitest';

import { KiroCliCompanionService, resolveKiroLinuxArchiveSuffix } from './KiroCliCompanionService';

const VALID_UNIX_INSTALLER = `#!/bin/bash
# Kiro CLI
BASE_URL="https://prod.download.cli.kiro.dev"
HASH_TOOL="sha256"
download_and_verify() { echo checksum; }
`;

const VALID_WINDOWS_INSTALLER = `# Kiro CLI
$ErrorActionPreference = "Stop"
$BaseUrl = "https://prod.download.cli.kiro.dev/stable"
$expectedSha = $artifact.sha256
Get-FileHash -Algorithm SHA256
msiexec /i kiro.msi
`;

describe('KiroCliCompanionService', () => {
  it('matches the official glibc and musl Linux archive thresholds', () => {
    expect(resolveKiroLinuxArchiveSuffix('x64', '2.34')).toBe('kirocli-x86_64-linux.zip');
    expect(resolveKiroLinuxArchiveSuffix('x64', '2.33')).toBe('kirocli-x86_64-linux-musl.zip');
    expect(resolveKiroLinuxArchiveSuffix('arm64', '2.39')).toBe('kirocli-aarch64-linux.zip');
    expect(resolveKiroLinuxArchiveSuffix('arm64', '2.38')).toBe('kirocli-aarch64-linux-musl.zip');
  });
  it('reports a missing CLI with the official fallback', async () => {
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => null,
    });

    const status = await service.getStatus();

    expect(status.phase).toBe('missing');
    expect(status.installed).toBe(false);
    expect(status.manualCommand).toBe('curl -fsSL https://cli.kiro.dev/install | bash');
    expect(status.manualUrl).toBe('https://kiro.dev/downloads/');
  });

  it('installs, signs in, and reports staged progress', async () => {
    let installed = false;
    let authenticated = false;
    const progress: string[] = [];
    const runCommand = vi.fn(async (command: string, args: readonly string[], options) => {
      if (command === '/bin/bash') {
        options.onOutput?.('Downloading package...\n');
        options.onOutput?.('Verifying checksum...\n');
        options.onOutput?.('Package installed successfully\n');
        installed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'login') {
        authenticated = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'whoami') {
        return authenticated
          ? { exitCode: 0, stdout: '{"account":"test"}', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'Not logged in' };
      }
      return { exitCode: 0, stdout: 'kiro-cli 1.26.0', stderr: '' };
    });
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      fetchInstallerScript: async () => VALID_UNIX_INSTALLER,
      resolveBinary: async () => (installed ? '/Users/test/.local/bin/kiro-cli' : null),
      runCommand,
      sleep: async () => {},
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      emitProgress: (status) => progress.push(`${status.phase}:${status.percent ?? '-'}`),
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('connected');
    expect(status.authenticated).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(
      '/bin/bash',
      expect.arrayContaining([expect.stringContaining('install.sh')]),
      expect.objectContaining({ timeoutMs: 2_700_000 })
    );
    expect(progress).toEqual(
      expect.arrayContaining([
        'downloading:12',
        'installing:28',
        'installing:42',
        'installing:62',
        'installing:76',
        'verifying-install:82',
        'signing-in:88',
        'verifying-auth:96',
        'connected:100',
      ])
    );
  });

  it('stops safely and exposes manual setup when the official script format changes', async () => {
    const runCommand = vi.fn();
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      fetchInstallerScript: async () => '#!/bin/bash\necho changed',
      resolveBinary: async () => null,
      runCommand,
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toContain('changed its installer format');
    expect(status.manualCommand).toContain('https://cli.kiro.dev/install');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('fails before downloading the package when free disk space is unsafe', async () => {
    const runCommand = vi.fn();
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      fetchInstallerScript: async () => VALID_UNIX_INSTALLER,
      fetchPackageSize: async () => 700 * 1024 * 1024,
      getAvailableBytes: async () => 2 * 1024 * 1024 * 1024,
      resolveBinary: async () => null,
      runCommand,
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toContain('Not enough free disk space');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps an installed CLI and offers sign-in retry when browser auth fails', async () => {
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/kiro-cli',
      runCommand: async (_command, args) => {
        if (args[0] === '--version') {
          return { exitCode: 0, stdout: 'kiro-cli 1.26.0', stderr: '' };
        }
        if (args[0] === 'login') {
          return { exitCode: 1, stdout: '', stderr: 'Authorization cancelled' };
        }
        return { exitCode: 1, stdout: '', stderr: 'Not logged in' };
      },
    });

    const status = await service.connect();

    expect(status.phase).toBe('error');
    expect(status.installed).toBe(true);
    expect(status.error).toContain('Authorization cancelled');
  });

  it('retries a transient whoami miss while the Kiro credential helper starts', async () => {
    let whoamiAttempts = 0;
    const sleep = vi.fn(async () => {});
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
      sleep,
      runCommand: async (_command, args) => {
        if (args[0] === 'whoami') {
          whoamiAttempts += 1;
          return whoamiAttempts === 1
            ? { exitCode: 1, stdout: '{"account":null}', stderr: '' }
            : { exitCode: 0, stdout: '{"account":"test"}', stderr: '' };
        }
        return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
      },
    });

    const status = await service.getStatus();

    expect(whoamiAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(status.phase).toBe('connected');
  });

  it.each([
    {
      platform: 'linux' as const,
      script: VALID_UNIX_INSTALLER,
      installCommand: '/bin/bash',
      tempEnvKey: 'TMPDIR',
      binary: '/home/test/.local/bin/kiro-cli',
      manualCommand: 'curl -fsSL https://cli.kiro.dev/install | bash',
    },
    {
      platform: 'win32' as const,
      script: VALID_WINDOWS_INSTALLER,
      installCommand: 'powershell.exe',
      tempEnvKey: 'TEMP',
      binary: 'C:\\Program Files\\Kiro-Cli\\kiro-cli.exe',
      manualCommand: 'irm https://cli.kiro.dev/install.ps1 | iex',
    },
  ])('uses the official $platform installer contract and temp root', async (scenario) => {
    let installed = false;
    let authenticated = false;
    const runCommand = vi.fn(async (command: string, args: readonly string[], _options) => {
      if (command === scenario.installCommand) {
        installed = true;
        return { exitCode: 0, stdout: 'Installed successfully', stderr: '' };
      }
      if (args[0] === 'login') {
        authenticated = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'whoami') {
        return authenticated
          ? { exitCode: 0, stdout: '{"account":"test"}', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'Not logged in' };
      }
      return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
    });
    const service = new KiroCliCompanionService({
      platform: scenario.platform,
      arch: 'x64',
      homeDir: scenario.platform === 'win32' ? 'C:\\Users\\test' : '/home/test',
      fetchInstallerScript: async () => scenario.script,
      fetchPackageSize: async () => 100 * 1024 * 1024,
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      resolveBinary: async () => (installed ? scenario.binary : null),
      runCommand,
      sleep: async () => {},
    });

    const status = await service.installAndConnect();

    const installCall = runCommand.mock.calls.find(
      ([command]) => command === scenario.installCommand
    );
    expect(installCall?.[2].env[scenario.tempEnvKey]).toContain('agent-teams-kiro-');
    expect(status.phase).toBe('connected');
    expect(status.binaryPath).toBe(scenario.binary);
    expect(status.manualCommand).toBe(scenario.manualCommand);
  });
});
