// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const resolveBinaryMock = vi.fn();

vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
  };
});

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: () => resolveBinaryMock(),
    clearCache: vi.fn(),
  },
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(() => Promise.resolve({})),
  resolveInteractiveShellEnvBestEffort: vi.fn(() => Promise.resolve({})),
  getCachedShellEnv: vi.fn(() => null),
  getShellPreferredHome: vi.fn(() => '/Users/tester'),
}));

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
}));

vi.mock('@main/utils/cliAuthDiagLog', () => ({
  appendCliAuthDiag: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('https', () => ({
  default: {
    get: vi.fn(() => {
      const req = {
        setTimeout: vi.fn(),
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === 'error') {
            queueMicrotask(() => handler(new Error('offline')));
          }
          return req;
        }),
        destroy: vi.fn(),
      };
      return req;
    }),
  },
}));

vi.mock('http', () => ({
  default: {
    get: vi.fn(() => {
      const req = {
        setTimeout: vi.fn(),
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === 'error') {
            queueMicrotask(() => handler(new Error('offline')));
          }
          return req;
        }),
        destroy: vi.fn(),
      };
      return req;
    }),
  },
}));

import { CliInstallerService } from '@main/services/infrastructure/CliInstallerService';
import { createDefaultProviderStatus } from '@main/services/runtime/providerStatusCheckContract';
import type { CliInstallationStatus } from '@shared/types';

describe('CliInstallerService health check', () => {
  let service: CliInstallerService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new CliInstallerService();
  });

  it('does not treat a found binary as installed until --version succeeds', async () => {
    resolveBinaryMock.mockResolvedValue('/usr/local/bin/claude');
    execCliMock.mockRejectedValue(new Error('spawn EACCES'));

    const status = await service.getStatus();

    expect(status.installed).toBe(false);
    expect(status.binaryPath).toBe('/usr/local/bin/claude');
    expect(status.installedVersion).toBeNull();
    expect(status.launchError).toContain('spawn EACCES');
    expect(status.authStatusChecking).toBe(false);
  });

  it('marks the CLI installed after a successful version probe', async () => {
    resolveBinaryMock.mockResolvedValue('/usr/local/bin/claude');
    execCliMock
      .mockResolvedValueOnce({ stdout: '2.1.100 (Claude Code)', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
        stderr: '',
      });

    const status = await service.getStatus();

    expect(status.installed).toBe(true);
    expect(status.binaryPath).toBe('/usr/local/bin/claude');
    expect(status.installedVersion).toBe('2.1.100');
    expect(status.launchError).toBeNull();
  });
});

it('selected Native status bypasses fork discovery/probes, uncaptured cache and fork installation', async () => {
  const initial: CliInstallationStatus = {
    flavor: 'agent_teams_orchestrator',
    displayName: 'TEST Host',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: 'TEST-build',
    binaryPath: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: false,
    authMethod: null,
    providers: [createDefaultProviderStatus('opencode')],
  };
  execCliMock.mockClear();
  resolveBinaryMock.mockClear();
  const native = {
    getStatus: vi.fn(async () => ({
      ...initial,
      displayName: 'TEST Native Host',
      installed: true,
      installedVersion: 'TEST-build',
      binaryPath: null,
      supportsSelfUpdate: false,
    })),
    getProviderStatus: vi.fn(async () => ({
      ...initial.providers[0]!,
      providerId: 'opencode' as const,
    })),
    verifyProviderModels: vi.fn(async () => ({
      ...initial.providers[0]!,
      providerId: 'opencode' as const,
    })),
  };
  const service = new CliInstallerService(Date.now, native);
  expect(service.usesNativeStatus()).toBe(true);
  expect((await service.getStatus()).displayName).toBe('TEST Native Host');
  await service.getProviderStatus('opencode', { projectPath: '/TEST/project' });
  await service.verifyProviderModels('opencode');
  expect(native.getProviderStatus).toHaveBeenCalledWith('opencode', {
    projectPath: '/TEST/project',
  });
  expect(service.getLatestStatusSnapshot()).toBeNull();
  await expect(service.install()).rejects.toThrow('selected Host');
  expect(execCliMock).not.toHaveBeenCalled();
  expect(resolveBinaryMock).not.toHaveBeenCalled();
});
