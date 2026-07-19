import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  KIRO_CLI_COMPANION_DEFINITION,
  parseKiroWhoamiAccount,
} from './cli-companion/definitions/KiroCliCompanionDefinition';
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('KiroCliCompanionService', () => {
  it('parses the empirical whoami JSON and ignores the non-JSON profile trailer', () => {
    const result = {
      exitCode: 0,
      stdout:
        '{"accountType":"IamIdentityCenter","email":"dev@example.com","region":"eu-west-1","startUrl":"https://example.awsapps.com/start"}\n\nProfile:\nKiroProfile-eu-central-1',
      stderr: '',
    };

    expect(parseKiroWhoamiAccount(result)).toEqual({
      display: 'dev@example.com',
      email: 'dev@example.com',
      accountType: 'IamIdentityCenter',
      region: 'eu-west-1',
    });
    expect(KIRO_CLI_COMPANION_DEFINITION.auth.isAuthenticated(result)).toBe(true);
  });

  it.each([
    { exitCode: 0, stdout: '{"account":null}', stderr: '' },
    { exitCode: 0, stdout: '{"accountType":"   "}', stderr: '' },
    { exitCode: 0, stdout: 'not json', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'Not logged in' },
  ])('does not treat non-empty logged-out output as authenticated', (result) => {
    expect(parseKiroWhoamiAccount(result)).toBeNull();
    expect(KIRO_CLI_COMPANION_DEFINITION.auth.isAuthenticated(result)).toBe(false);
  });

  it('accepts a valid whoami auth object from stderr even when the command exits nonzero', () => {
    const result = {
      exitCode: 1,
      stdout: '',
      stderr: '{"accountType":"BuilderId","email":"dev@example.com"}',
    };
    expect(KIRO_CLI_COMPANION_DEFINITION.auth.isAuthenticated(result)).toBe(true);
  });

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
          ? {
              exitCode: 0,
              stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
              stderr: '',
            }
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

  it('discovers the current per-user Windows MSI install location', () => {
    const candidates = KIRO_CLI_COMPANION_DEFINITION.binary.extraCandidates(
      'win32',
      'C:\\Users\\test'
    );

    expect(candidates).toContain(
      path.join(process.env.LOCALAPPDATA ?? '', 'Kiro-Cli', 'kiro-cli.exe')
    );
  });

  it('surfaces installer stderr instead of the last progress line', async () => {
    const service = new KiroCliCompanionService({
      platform: 'win32',
      arch: 'x64',
      fetchInstallerScript: async () => VALID_WINDOWS_INSTALLER,
      fetchPackageSize: async () => 100 * 1024 * 1024,
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      resolveBinary: async () => null,
      runCommand: async () => ({
        exitCode: 1,
        stdout: 'Downloaded\nVerifying checksum...\n',
        stderr: 'Get-FileHash is not available\nFullyQualifiedErrorId: CommandNotFoundException\n',
      }),
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toBe('Get-FileHash is not available');
  });

  it('surfaces the official MSI exit code instead of the trailing manual-install hint', async () => {
    const service = new KiroCliCompanionService({
      platform: 'win32',
      arch: 'x64',
      fetchInstallerScript: async () => VALID_WINDOWS_INSTALLER,
      fetchPackageSize: async () => 100 * 1024 * 1024,
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      resolveBinary: async () => null,
      runCommand: async () => ({
        exitCode: 1,
        stdout: [
          'Installing Kiro CLI...',
          'Installation failed with exit code 1603',
          'You can try installing manually: C:\\Temp\\kiro-cli-installer.msi',
        ].join('\n'),
        stderr: '',
      }),
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toBe('Installation failed with exit code 1603');
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
            : {
                exitCode: 0,
                stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
                stderr: '',
              };
        }
        return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
      },
    });

    const status = await service.getStatus();

    expect(whoamiAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(status.phase).toBe('connected');
  });

  it('signs out the user-wide Kiro session and clears the account', async () => {
    let authenticated = true;
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'whoami') {
        return authenticated
          ? {
              exitCode: 0,
              stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
              stderr: '',
            }
          : { exitCode: 0, stdout: '{"account":null}', stderr: '' };
      }
      if (args[0] === 'logout') {
        authenticated = false;
        return { exitCode: 0, stdout: 'Logged out', stderr: '' };
      }
      return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
    });
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/kiro-cli',
      runCommand,
      sleep: async () => {},
    });

    await expect(service.runAction('logout')).resolves.toMatchObject({
      phase: 'sign-in-required',
      authenticated: false,
      account: null,
      actionOutput: 'Logged out',
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/Users/test/.local/bin/kiro-cli',
      ['logout'],
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it('runs no-fix diagnostics and preserves the connected account', async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'whoami') {
        return {
          exitCode: 0,
          stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
          stderr: '',
        };
      }
      if (args[0] === 'doctor') {
        return { exitCode: 0, stdout: '{"checks":"ok"}', stderr: '' };
      }
      return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
    });
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/kiro-cli',
      runCommand,
      sleep: async () => {},
    });

    await expect(service.runAction('doctor')).resolves.toMatchObject({
      phase: 'connected',
      authenticated: true,
      actionOutput: '{"checks":"ok"}',
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/Users/test/.local/bin/kiro-cli',
      ['doctor', '--all', '--format', 'json'],
      expect.objectContaining({ timeoutMs: 120_000 })
    );
  });

  it('switches accounts by signing out before starting a fresh browser login', async () => {
    let authenticated = true;
    let email = 'old@example.com';
    const calls: string[] = [];
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/kiro-cli',
      sleep: async () => {},
      runCommand: async (_command, args) => {
        calls.push(args[0] ?? '');
        if (args[0] === 'logout') {
          authenticated = false;
          return { exitCode: 0, stdout: 'Logged out', stderr: '' };
        }
        if (args[0] === 'login') {
          authenticated = true;
          email = 'new@example.com';
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'whoami') {
          return authenticated
            ? {
                exitCode: 0,
                stdout: `{"accountType":"BuilderId","email":"${email}"}`,
                stderr: '',
              }
            : { exitCode: 0, stdout: '{"account":null}', stderr: '' };
        }
        return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
      },
    });

    await expect(service.runAction('switch-account')).resolves.toMatchObject({
      phase: 'connected',
      account: { email: 'new@example.com' },
    });
    expect(calls.indexOf('logout')).toBeLessThan(calls.indexOf('login'));
  });

  it('does not let a status refresh started before connect overwrite the connected result', async () => {
    const firstBinaryProbe = deferred<string | null>();
    const progress: string[] = [];
    let binaryProbeCalls = 0;
    let authenticated = false;
    const service = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: () => {
        binaryProbeCalls += 1;
        return binaryProbeCalls === 1
          ? firstBinaryProbe.promise
          : Promise.resolve('/Users/test/.local/bin/kiro-cli');
      },
      runCommand: async (_command, args) => {
        if (args[0] === 'login') {
          authenticated = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'whoami') {
          return authenticated
            ? {
                exitCode: 0,
                stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
                stderr: '',
              }
            : { exitCode: 1, stdout: '', stderr: 'Not logged in' };
        }
        return { exitCode: 0, stdout: 'kiro-cli 2.12.1', stderr: '' };
      },
      sleep: async () => {},
      emitProgress: (status) => progress.push(status.phase),
    });

    const staleStatus = service.getStatus();
    await vi.waitFor(() => expect(binaryProbeCalls).toBe(1));

    await expect(service.installAndConnect()).resolves.toMatchObject({
      phase: 'connected',
      authenticated: true,
    });
    firstBinaryProbe.resolve(null);

    await expect(staleStatus).resolves.toMatchObject({
      phase: 'connected',
      authenticated: true,
    });
    expect(service.getCurrentStatus()).toMatchObject({
      phase: 'connected',
      authenticated: true,
    });
    expect(progress).not.toContain('missing');
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
          ? {
              exitCode: 0,
              stdout: '{"accountType":"BuilderId","email":"test@example.com"}',
              stderr: '',
            }
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
    expect(installCall?.[2].isolateFromHost).toBe(scenario.platform === 'win32');
    if (scenario.platform === 'win32') {
      expect(
        Object.keys(installCall?.[2].env ?? {}).some((key) => key.toLowerCase() === 'psmodulepath')
      ).toBe(false);
    }
    expect(status.phase).toBe('connected');
    expect(status.binaryPath).toBe(scenario.binary);
    expect(status.manualCommand).toBe(scenario.manualCommand);
  });
});
