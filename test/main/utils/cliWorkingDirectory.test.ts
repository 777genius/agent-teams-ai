// @vitest-environment node
import { execCli } from '@main/utils/childProcess';
import {
  classifyCliSpawnError,
  isExistingDirectory,
  isWorkingDirectoryMissingError,
  WorkingDirectoryMissingError,
} from '@main/utils/cliWorkingDirectory';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('treats files and missing paths as non-directories', async () => {
    const filePath = path.join(root, 'file.txt');
    writeFileSync(filePath, 'x');

    expect(await isExistingDirectory(root)).toBe(true);
    expect(await isExistingDirectory(filePath)).toBe(false);
    expect(await isExistingDirectory(path.join(root, 'missing'))).toBe(false);
  });
});
