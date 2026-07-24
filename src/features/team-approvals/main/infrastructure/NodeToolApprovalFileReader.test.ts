import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NodeToolApprovalFileReader,
  TOOL_APPROVAL_MAX_FILE_SIZE,
} from './NodeToolApprovalFileReader';

describe('NodeToolApprovalFileReader', () => {
  const reader = new NodeToolApprovalFileReader();
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-approvals-file-reader-'));
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('distinguishes missing paths, directories, and text files', async () => {
    const missingPath = path.join(tempDirectory, 'missing.txt');
    await expect(reader.read(missingPath)).resolves.toEqual({
      content: '',
      exists: false,
      truncated: false,
      isBinary: false,
    });

    const directoryPath = path.join(tempDirectory, 'directory');
    await mkdir(directoryPath);
    await expect(reader.read(directoryPath)).resolves.toEqual({
      content: '',
      exists: true,
      truncated: false,
      isBinary: false,
      error: 'Not a file',
    });

    const textPath = path.join(tempDirectory, 'text.txt');
    await writeFile(textPath, 'hello approval');
    await expect(reader.read(textPath)).resolves.toEqual({
      content: 'hello approval',
      exists: true,
      truncated: false,
      isBinary: false,
    });
  });

  it('keeps the exact 2 MiB boundary and truncates only larger files', async () => {
    const exactPath = path.join(tempDirectory, 'exact.txt');
    await writeFile(exactPath, Buffer.alloc(TOOL_APPROVAL_MAX_FILE_SIZE, 0x61));
    const exact = await reader.read(exactPath);
    expect(exact).toMatchObject({ exists: true, truncated: false, isBinary: false });
    expect(Buffer.byteLength(exact.content)).toBe(TOOL_APPROVAL_MAX_FILE_SIZE);

    const oversizedPath = path.join(tempDirectory, 'oversized.txt');
    await writeFile(oversizedPath, Buffer.alloc(TOOL_APPROVAL_MAX_FILE_SIZE + 1, 0x62));
    const oversized = await reader.read(oversizedPath);
    expect(oversized).toMatchObject({ exists: true, truncated: true, isBinary: false });
    expect(Buffer.byteLength(oversized.content)).toBe(TOOL_APPROVAL_MAX_FILE_SIZE);
  });

  it('detects null bytes only inside the first 8 KiB', async () => {
    const earlyNullPath = path.join(tempDirectory, 'early-null.bin');
    const earlyNull = Buffer.alloc(9 * 1024, 0x61);
    earlyNull[8 * 1024 - 1] = 0;
    await writeFile(earlyNullPath, earlyNull);
    await expect(reader.read(earlyNullPath)).resolves.toEqual({
      content: '',
      exists: true,
      truncated: false,
      isBinary: true,
    });

    const lateNullPath = path.join(tempDirectory, 'late-null.txt');
    const lateNull = Buffer.alloc(8 * 1024 + 1, 0x61);
    lateNull[8 * 1024] = 0;
    await writeFile(lateNullPath, lateNull);
    const result = await reader.read(lateNullPath);
    expect(result).toMatchObject({ exists: true, truncated: false, isBinary: false });
    expect(result.content.charCodeAt(8 * 1024)).toBe(0);
  });

  it('contains filesystem failures in the stable file-preview response', async () => {
    const invalidPath = `${tempDirectory}/invalid\0path`;
    const result = await reader.read(invalidPath);

    expect(result).toMatchObject({
      content: '',
      exists: true,
      truncated: false,
      isBinary: false,
    });
    expect(result.error).toEqual(expect.any(String));
  });
});
