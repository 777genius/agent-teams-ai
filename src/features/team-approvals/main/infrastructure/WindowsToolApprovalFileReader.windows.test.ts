import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      error: 'Safe approval preview rejected a redirected Windows path',
    });
  });
});
