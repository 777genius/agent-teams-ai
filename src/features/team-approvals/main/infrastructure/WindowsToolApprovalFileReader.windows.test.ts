import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeToolApprovalFileReader } from './NodeToolApprovalFileReader';
import { WindowsToolApprovalFileReader } from './WindowsToolApprovalFileReader';

describe.runIf(process.platform === 'win32')('WindowsToolApprovalFileReader', () => {
  const reader = new WindowsToolApprovalFileReader();
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-approvals-windows-reader-'));
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('reads the same regular file through standard and extended paths', async () => {
    const textPath = path.join(tempDirectory, 'windows-preview.txt');
    await writeFile(textPath, 'approved Windows content');

    const expected = {
      content: 'approved Windows content',
      exists: true,
      truncated: false,
      isBinary: false,
    };
    await expect(reader.read(textPath)).resolves.toEqual(expected);
    await expect(reader.read(`\\\\?\\${textPath}`)).resolves.toEqual(expected);
  });

  it('rejects parent junctions through no-follow handles', async () => {
    const outsideDirectory = path.join(tempDirectory, 'windows-outside');
    const linkedDirectory = path.join(tempDirectory, 'windows-linked');
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, 'secret.txt'), 'unapproved secret');
    await symlink(outsideDirectory, linkedDirectory, 'junction');

    await expect(reader.read(path.join(linkedDirectory, 'secret.txt'))).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringMatching(/redirected Windows path|reparse-point path/),
    });
  });

  it('rejects a missing final file behind a parent junction', async () => {
    const outsideDirectory = path.join(tempDirectory, 'windows-missing-outside');
    const linkedDirectory = path.join(tempDirectory, 'windows-missing-linked');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, linkedDirectory, 'junction');

    await expect(reader.read(path.join(linkedDirectory, 'new-file.txt'))).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringContaining('reparse-point path'),
    });
  });

  it('preserves missing-file previews when every existing ancestor is safe', async () => {
    const safeDirectory = path.join(tempDirectory, 'windows-safe-parent');
    await mkdir(safeDirectory);

    await expect(reader.read(path.join(safeDirectory, 'new-file.txt'))).resolves.toEqual({
      content: '',
      exists: false,
      truncated: false,
      isBinary: false,
    });
  });

  it('rejects a native dot-space parent alias before it can escape its directory', async () => {
    const restrictedDirectory = path.join(tempDirectory, 'windows-restricted');
    await mkdir(restrictedDirectory);
    const secretPath = path.join(tempDirectory, 'windows-secret-parent-alias.txt');
    await writeFile(secretPath, 'unapproved alias target');

    const rawAliasPath = path.join(restrictedDirectory, '.. ', path.basename(secretPath));
    await expect(readFile(rawAliasPath, 'utf8')).resolves.toBe('unapproved alias target');

    const nodeReader = new NodeToolApprovalFileReader();
    await expect(nodeReader.read(rawAliasPath)).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringContaining('Parent path traversal is not allowed'),
    });
  });

  it('rejects hard-linked files using the opened native handle', async () => {
    const secretPath = path.join(tempDirectory, 'windows-secret.txt');
    const approvedPath = path.join(tempDirectory, 'windows-approved.txt');
    await writeFile(secretPath, 'sensitive Windows content');
    await link(secretPath, approvedPath);

    await expect(reader.read(approvedPath)).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringContaining('Hard-linked files are not allowed'),
    });
  });

  it('fails closed when requested casing differs from the opened canonical path', async () => {
    const caseSensitiveSegment = 'CaseSensitiveTarget';
    const targetDirectory = path.join(tempDirectory, caseSensitiveSegment);
    await mkdir(targetDirectory);
    await writeFile(path.join(targetDirectory, 'preview.txt'), 'must not be returned');

    const differentlyCasedPath = path.join(
      tempDirectory,
      caseSensitiveSegment.toLowerCase(),
      'preview.txt'
    );
    await expect(reader.read(differentlyCasedPath)).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringContaining('Safe approval preview rejected a redirected Windows path'),
    });
  });
});
