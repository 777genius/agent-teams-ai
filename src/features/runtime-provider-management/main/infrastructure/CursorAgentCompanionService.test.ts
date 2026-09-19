import { afterEach, describe, expect, it, vi } from 'vitest';

import { CURSOR_AGENT_COMPANION_DEFINITION } from './cli-companion/definitions/CursorAgentCompanionDefinition';
import { selectRuntimeProviderCompanionBinary } from './cli-companion/RuntimeProviderCliCompanionService';
import { CursorAgentCompanionService } from './CursorAgentCompanionService';

const VALID_UNIX_INSTALLER = `#!/usr/bin/env bash
echo "Cursor Agent Installer"
DOWNLOAD_URL="https://downloads.cursor.com/lab/version/darwin/arm64/agent-cli-package.tar.gz"
echo cursor-agent
echo "Downloading Cursor Agent package"
echo "Package downloaded and extracted"
echo "Installation Complete"
`;

const VALID_WINDOWS_INSTALLER = `$downloadUrl = 'https://downloads.cursor.com/lab/version/'
function Initialize-CursorAgent {}
Invoke-WebRequest -Uri $downloadUrl
Write-Host cursor-agent
`;

describe('CursorAgentCompanionService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the official platform-specific fallback when the CLI is missing', async () => {
    const unix = new CursorAgentCompanionService({
      platform: 'darwin',
      resolveBinary: async () => null,
    });
    const windows = new CursorAgentCompanionService({
      platform: 'win32',
      resolveBinary: async () => null,
    });

    expect((await unix.getStatus()).manualCommand).toBe(
      'curl https://cursor.com/install -fsS | bash'
    );
    expect((await windows.getStatus()).manualCommand).toBe(
      "irm 'https://cursor.com/install?win32=true' | iex"
    );
  });

  it.each([
    { platform: 'darwin' as const, arch: 'arm64', script: VALID_UNIX_INSTALLER },
    { platform: 'linux' as const, arch: 'x64', script: VALID_UNIX_INSTALLER },
    { platform: 'win32' as const, arch: 'x64', script: VALID_WINDOWS_INSTALLER },
    { platform: 'win32' as const, arch: 'arm64', script: VALID_WINDOWS_INSTALLER },
  ])('installs, signs in, and verifies the binary on $platform/$arch', async (scenario) => {
    let installed = false;
    let authenticated = false;
    const progress: string[] = [];
    const progressDetails: string[] = [];
    const runCommand = vi.fn(async (command: string, args: readonly string[], options) => {
      if (command === '/bin/bash' || command === 'powershell.exe') {
        options.onOutput?.(
          scenario.platform === 'win32'
            ? 'Invoke-WebRequest\nExpand-Archive\nHappy coding\n'
            : 'Downloading Cursor Agent package\nPackage downloaded and extracted\nInstallation Complete\n'
        );
        installed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'login') {
        authenticated = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        return authenticated
          ? { exitCode: 0, stdout: 'Logged in as test@example.com', stderr: '' }
          : { exitCode: 0, stdout: 'Not logged in', stderr: '' };
      }
      return { exitCode: 0, stdout: 'cursor-agent 2026.07.09', stderr: '' };
    });
    const service = new CursorAgentCompanionService({
      platform: scenario.platform,
      arch: scenario.arch,
      fetchInstallerScript: async () => scenario.script,
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      resolveBinary: async () => (installed ? '/test/cursor-agent' : null),
      runCommand,
      sleep: async () => {},
      emitProgress: (status) => {
        progress.push(`${status.phase}:${status.percent ?? '-'}`);
        if (status.detail) progressDetails.push(status.detail);
      },
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('connected');
    expect(status.authenticated).toBe(true);
    expect(status.binaryPath).toBe('/test/cursor-agent');
    expect(progress).toEqual(
      expect.arrayContaining([
        'downloading:12',
        'installing:28',
        'verifying-install:82',
        'signing-in:88',
        'verifying-auth:96',
        'connected:100',
      ])
    );
    expect(progressDetails.join('\n').toLowerCase()).not.toMatch(/checksum|signed package/);
  });

  it('does not mistake a successful "Not logged in" status command for authentication', async () => {
    const service = new CursorAgentCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/cursor-agent',
      sleep: async () => {},
      runCommand: async (_command, args) =>
        args[0] === 'status'
          ? { exitCode: 0, stdout: 'Not logged in', stderr: '' }
          : { exitCode: 0, stdout: 'cursor-agent 2026.07.09', stderr: '' },
    });

    const status = await service.getStatus();

    expect(status.phase).toBe('sign-in-required');
    expect(status.authenticated).toBe(false);
  });

  it('stops before execution when the official installer format changes', async () => {
    const runCommand = vi.fn();
    const service = new CursorAgentCompanionService({
      platform: 'linux',
      arch: 'x64',
      fetchInstallerScript: async () => '#!/usr/bin/env bash\necho changed',
      resolveBinary: async () => null,
      runCommand,
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toContain('changed its installer format');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects an installer redirected outside the exact official host allowlist', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://cursor.com.example.test/install',
      headers: new Headers({ 'content-length': String(VALID_UNIX_INSTALLER.length) }),
      text: async () => VALID_UNIX_INSTALLER,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const runCommand = vi.fn();
    const service = new CursorAgentCompanionService({
      platform: 'darwin',
      arch: 'arm64',
      resolveBinary: async () => null,
      runCommand,
    });

    const status = await service.installAndConnect();

    expect(status.phase).toBe('needs-manual-step');
    expect(status.error).toContain('unexpected host');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('coalesces concurrent setup calls into one installer operation', async () => {
    let installed = false;
    let finishInstall!: () => void;
    const installBarrier = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/bin/bash') {
        await installBarrier;
        installed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        return { exitCode: 0, stdout: 'Logged in', stderr: '' };
      }
      return { exitCode: 0, stdout: 'cursor-agent 2026.07.09', stderr: '' };
    });
    const service = new CursorAgentCompanionService({
      platform: 'darwin',
      arch: 'arm64',
      fetchInstallerScript: async () => VALID_UNIX_INSTALLER,
      getAvailableBytes: async () => 10 * 1024 * 1024 * 1024,
      resolveBinary: async () => (installed ? '/test/cursor-agent' : null),
      runCommand,
      sleep: async () => {},
    });

    const first = service.installAndConnect();
    const second = service.installAndConnect();
    expect(second).toBe(first);
    finishInstall();
    await Promise.all([first, second]);

    expect(runCommand.mock.calls.filter(([command]) => command === '/bin/bash')).toHaveLength(1);
  });

  it('prefers cursor-agent over a colliding generic agent name', () => {
    expect(CURSOR_AGENT_COMPANION_DEFINITION.binary.ambiguousExecutableNames).toEqual([
      'agent',
      'agent.exe',
      'agent.cmd',
    ]);
    expect(
      CURSOR_AGENT_COMPANION_DEFINITION.binary.extraCandidates('darwin', '/Users/test')[0]
    ).toBe('/Users/test/.local/bin/cursor-agent');
    expect(
      CURSOR_AGENT_COMPANION_DEFINITION.binary.matchesVersionOutput?.(
        'grok 1.0.34 (3736acbc8658)\n'
      )
    ).toBe(false);
    expect(
      CURSOR_AGENT_COMPANION_DEFINITION.binary.matchesVersionOutput?.('2026.09.15-d2fe57e\n')
    ).toBe(true);
  });

  it('skips a grok agent binary when cursor-agent is also on PATH', async () => {
    const selected = await selectRuntimeProviderCompanionBinary({
      candidates: ['/Users/test/.local/bin/agent', '/Users/test/.local/bin/cursor-agent'],
      versionArgs: ['--version'],
      env: {},
      matchesVersionOutput: CURSOR_AGENT_COMPANION_DEFINITION.binary.matchesVersionOutput,
      ambiguousExecutableNames: CURSOR_AGENT_COMPANION_DEFINITION.binary.ambiguousExecutableNames,
      runCommand: async (command) =>
        command.endsWith('cursor-agent')
          ? { exitCode: 0, stdout: '2026.09.15-d2fe57e', stderr: '' }
          : { exitCode: 0, stdout: 'grok 1.0.34 (3736acbc8658)', stderr: '' },
    });
    expect(selected).toBe('/Users/test/.local/bin/cursor-agent');
  });

  it('selects cursor-agent without waiting on a slow --version probe', async () => {
    const selected = await selectRuntimeProviderCompanionBinary({
      candidates: ['/Users/test/.local/bin/cursor-agent', '/Users/test/.local/bin/agent'],
      versionArgs: ['--version'],
      env: {},
      matchesVersionOutput: CURSOR_AGENT_COMPANION_DEFINITION.binary.matchesVersionOutput,
      ambiguousExecutableNames: CURSOR_AGENT_COMPANION_DEFINITION.binary.ambiguousExecutableNames,
      runCommand: async () => {
        throw new Error('cursor-agent timed out');
      },
    });
    expect(selected).toBe('/Users/test/.local/bin/cursor-agent');
  });

  it('rejects a grok-only agent binary when no cursor-agent candidate exists', async () => {
    const selected = await selectRuntimeProviderCompanionBinary({
      candidates: ['/Users/test/.local/bin/agent'],
      versionArgs: ['--version'],
      env: {},
      matchesVersionOutput: CURSOR_AGENT_COMPANION_DEFINITION.binary.matchesVersionOutput,
      ambiguousExecutableNames: CURSOR_AGENT_COMPANION_DEFINITION.binary.ambiguousExecutableNames,
      runCommand: async () => ({
        exitCode: 0,
        stdout: 'grok 1.0.34 (3736acbc8658)',
        stderr: '',
      }),
    });
    expect(selected).toBeNull();
  });
});
