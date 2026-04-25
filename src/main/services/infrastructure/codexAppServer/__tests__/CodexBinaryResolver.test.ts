// @vitest-environment node
import { constants as fsConstants } from 'node:fs';
import type { PathLike } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accessMock = vi.fn<(filePath: PathLike, mode?: number) => Promise<void>>();

vi.mock('node:fs/promises', () => ({
  access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
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
});
