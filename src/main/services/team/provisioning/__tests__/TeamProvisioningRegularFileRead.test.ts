import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryReadRegularFileUtf8 } from '../TeamProvisioningRegularFileRead';

describe('TeamProvisioningRegularFileRead', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-provisioning-read-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads a regular UTF-8 file within the byte limit', async () => {
    const filePath = path.join(tempDir, 'config.json');
    await writeFile(filePath, '{"name":"team"}', 'utf-8');

    await expect(
      tryReadRegularFileUtf8(filePath, { timeoutMs: 5_000, maxBytes: 1024 })
    ).resolves.toBe('{"name":"team"}');
  });

  it('returns null for missing paths, directories, and oversized files', async () => {
    const missingPath = path.join(tempDir, 'missing.json');
    const directoryPath = path.join(tempDir, 'directory');
    const oversizedPath = path.join(tempDir, 'large.json');
    await mkdir(directoryPath);
    await writeFile(oversizedPath, 'abcd', 'utf-8');

    await expect(
      tryReadRegularFileUtf8(missingPath, { timeoutMs: 5_000, maxBytes: 1024 })
    ).resolves.toBeNull();
    await expect(
      tryReadRegularFileUtf8(directoryPath, { timeoutMs: 5_000, maxBytes: 1024 })
    ).resolves.toBeNull();
    await expect(
      tryReadRegularFileUtf8(oversizedPath, { timeoutMs: 5_000, maxBytes: 3 })
    ).resolves.toBeNull();
  });
});
