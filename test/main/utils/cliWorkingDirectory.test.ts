// @vitest-environment node
import { execCli } from '@main/utils/childProcess';
import {
  classifyCliSpawnError,
  isWorkingDirectoryMissingError,
  WorkingDirectoryMissingError,
} from '@main/utils/cliWorkingDirectory';
import * as directoryPresence from '@main/utils/directoryPresence';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cli working directory classification', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cli-cwd-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing project folder when the binary exists but the cwd does not', async () => {
    const missingCwd = path.join(root, 'deleted-project');

    const error = await execCli(process.execPath, ['-e', ''], { cwd: missingCwd }).catch(
      (caught: unknown) => caught
    );

    expect(isWorkingDirectoryMissingError(error)).toBe(true);
    expect((error as WorkingDirectoryMissingError).cwd).toBe(missingCwd);
    expect((error as Error).message).toBe(`Working directory does not exist: ${missingCwd}`);
    expect((error as Error).message).not.toContain('spawn');
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('keeps the original ENOENT when the binary is missing and the cwd exists', async () => {
    const missingBinary = path.join(root, 'missing-cli');

    const error = await execCli(missingBinary, ['--version'], { cwd: root }).catch(
      (caught: unknown) => caught
    );

    expect(isWorkingDirectoryMissingError(error)).toBe(false);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('only rewrites ENOENT errors whose cwd is really gone', async () => {
    const enoent = Object.assign(new Error('spawn /bin/cli ENOENT'), { code: 'ENOENT' });
    const eacces = Object.assign(new Error('spawn /bin/cli EACCES'), { code: 'EACCES' });
    const missingCwd = path.join(root, 'gone');

    expect(await classifyCliSpawnError(enoent, root)).toBe(enoent);
    expect(await classifyCliSpawnError(enoent, undefined)).toBe(enoent);
    expect(await classifyCliSpawnError(eacces, missingCwd)).toBe(eacces);
    const classified = await classifyCliSpawnError(enoent, missingCwd);
    expect(classified).toBeInstanceOf(WorkingDirectoryMissingError);
    expect((classified as WorkingDirectoryMissingError).cause).toBe(enoent);
  });

  it('reports only definitive absence as a missing directory', async () => {
    const filePath = path.join(root, 'file.txt');
    writeFileSync(filePath, 'x');

    expect(await directoryPresence.readDirectoryPresence(root)).toBe('directory');
    expect(await directoryPresence.readDirectoryPresence(filePath)).toBe('not_directory');
    expect(await directoryPresence.readDirectoryPresence(path.join(root, 'missing'))).toBe(
      'missing'
    );
    expect(await directoryPresence.readDirectoryPresence(path.join(filePath, 'child'))).toBe(
      'missing'
    );
    expect(directoryPresence.isDefinitiveMissingPathError({ code: 'ENOENT' })).toBe(true);
    expect(directoryPresence.isDefinitiveMissingPathError({ code: 'EACCES' })).toBe(false);
    expect(directoryPresence.isDefinitiveMissingPathError({ code: 2 })).toBe(true);
  });

  it('keeps the original spawn error when the directory probe itself fails', async () => {
    const enoent = Object.assign(new Error('spawn /bin/cli ENOENT'), { code: 'ENOENT' });
    const probe = vi
      .spyOn(directoryPresence, 'isMissingDirectory')
      .mockRejectedValue(new Error('EIO: i/o error'));

    try {
      expect(await classifyCliSpawnError(enoent, path.join(root, 'gone'))).toBe(enoent);
      expect(probe).toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the original spawn error when the cwd is unreadable rather than missing',
    async () => {
      const lockedParent = path.join(root, 'locked');
      const lockedCwd = path.join(lockedParent, 'project');
      mkdirSync(lockedCwd, { recursive: true });
      chmodSync(lockedParent, 0o000);
      try {
        const enoent = Object.assign(new Error('spawn /bin/cli ENOENT'), { code: 'ENOENT' });

        expect(await directoryPresence.readDirectoryPresence(lockedCwd)).toBe('unknown');
        expect(await classifyCliSpawnError(enoent, lockedCwd)).toBe(enoent);
      } finally {
        chmodSync(lockedParent, 0o700);
      }
    }
  );
});
