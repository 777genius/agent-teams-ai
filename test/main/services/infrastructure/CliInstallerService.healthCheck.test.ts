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
