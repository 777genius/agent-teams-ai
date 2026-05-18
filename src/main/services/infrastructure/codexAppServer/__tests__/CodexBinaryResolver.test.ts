// @vitest-environment node
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PathLike } from 'node:fs';

const accessMock = vi.fn<(filePath: PathLike, mode?: number) => Promise<void>>();
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.fn<() => Promise<string | null>>();
const execCliMock =
  vi.fn<
    (
      binaryPath: string | null,
      args: string[],
      options?: { timeout?: number; windowsHide?: boolean }
    ) => Promise<{ stdout: string; stderr: string }>
  >();

vi.mock('node:fs/promises', () => ({
  access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (
    binaryPath: string | null,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean }
  ) => execCliMock(binaryPath, args, options),
}));

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalCodexCliPath = process.env.CODEX_CLI_PATH;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('CodexBinaryResolver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform('win32');
    process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM';
    delete process.env.CODEX_CLI_PATH;
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(null);
    execCliMock.mockResolvedValue({ stdout: 'codex-cli 0.130.0', stderr: '' });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    process.env.CODEX_CLI_PATH = originalCodexCliPath;
  });

  it('prefers the Windows command shim over the extensionless POSIX shim on PATH', async () => {
    const binDir = 'C:\\Program Files\\nodejs';
    const extensionless = path.win32.join(binDir, 'codex');
    const cmdShim = path.win32.join(binDir, 'codex.cmd');
    process.env.PATH = binDir;

    accessMock.mockImplementation((filePath, mode) => {
      expect(mode).toBe(fsConstants.X_OK);
      if (filePath === extensionless || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);
  });

  it('expands an explicit extensionless override to the Windows command shim first', async () => {
    const extensionless = 'C:\\Program Files\\nodejs\\codex';
    const cmdShim = 'C:\\Program Files\\nodejs\\codex.cmd';
    process.env.CODEX_CLI_PATH = extensionless;

    accessMock.mockImplementation((filePath) => {
      if (filePath === extensionless || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);
  });

  it('prefers a verified app-managed Codex binary before PATH lookup', async () => {
    const appManagedBinary = 'C:\\Users\\tester\\AppData\\Roaming\\AgentTeams\\codex.exe';
    const pathBinary = 'C:\\Program Files\\nodejs\\codex.cmd';
    process.env.PATH = 'C:\\Program Files\\nodejs';
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);

    accessMock.mockImplementation((filePath) => {
      if (filePath === appManagedBinary || filePath === pathBinary) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
  });

  it('recovers a negative cache entry when a verified app-managed Codex binary appears', async () => {
    const appManagedBinary = 'C:\\Users\\tester\\AppData\\Roaming\\AgentTeams\\codex.exe';
    process.env.PATH = '';

    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();

    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);
    accessMock.mockImplementation((filePath) => {
      if (filePath === appManagedBinary) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
  });

  it('skips Windows PATH candidates that exist but cannot be launched', async () => {
    const blockedDir =
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.422.3464.0_x64__2p2nqsd0c76g0\\app\\resources';
    const usableDir = 'C:\\Users\\User\\AppData\\Roaming\\npm';
    const blockedExe = path.win32.join(blockedDir, 'codex.exe');
    const cmdShim = path.win32.join(usableDir, 'codex.cmd');
    process.env.PATH = `${blockedDir};${usableDir}`;

    accessMock.mockImplementation((filePath) => {
      if (filePath === blockedExe || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation((binaryPath) => {
      if (binaryPath === blockedExe) {
        return Promise.reject(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
      }
      return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);
  });
});
