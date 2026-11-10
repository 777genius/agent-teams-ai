import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface RuntimeArchiveChecksumModule {
  computeFileSha256(filePath: string): Promise<string>;
  verifyRuntimeArchiveChecksum(
    archivePath: string,
    asset: { file?: string; sha256?: string },
    platformKey: string
  ): Promise<string>;
}

async function loadModule(): Promise<RuntimeArchiveChecksumModule> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/lib/runtime-archive-checksum.mjs')
  ).href;
  return (await import(moduleUrl)) as RuntimeArchiveChecksumModule;
}

describe('runtime-archive-checksum', () => {
  let dir: string;
  let archivePath: string;
  let sha256: string;
  const contents = Buffer.from('pretend-runtime-archive-bytes- ÿ', 'binary');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-checksum-'));
    archivePath = path.join(dir, 'runtime.tar.gz');
    fs.writeFileSync(archivePath, contents);
    sha256 = createHash('sha256').update(contents).digest('hex');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('computes a streaming sha256 matching node:crypto', async () => {
    const { computeFileSha256 } = await loadModule();
    await expect(computeFileSha256(archivePath)).resolves.toBe(sha256);
  });

  it('accepts an archive whose bytes match the pinned sha256', async () => {
    const { verifyRuntimeArchiveChecksum } = await loadModule();
    const asset = { file: 'runtime.tar.gz', sha256 };
    await expect(verifyRuntimeArchiveChecksum(archivePath, asset, 'linux-x64')).resolves.toBe(
      sha256
    );
  });

  it('accepts a pin regardless of case/whitespace', async () => {
    const { verifyRuntimeArchiveChecksum } = await loadModule();
    const asset = { file: 'runtime.tar.gz', sha256: `  ${sha256.toUpperCase()}  ` };
    await expect(verifyRuntimeArchiveChecksum(archivePath, asset, 'linux-x64')).resolves.toBe(
      sha256
    );
  });

  it('rejects an archive whose bytes were tampered after pinning', async () => {
    const { verifyRuntimeArchiveChecksum } = await loadModule();
    fs.appendFileSync(archivePath, 'x');
    const asset = { file: 'runtime.tar.gz', sha256 };
    await expect(
      verifyRuntimeArchiveChecksum(archivePath, asset, 'linux-x64')
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('refuses to run when no valid sha256 is pinned', async () => {
    const { verifyRuntimeArchiveChecksum } = await loadModule();
    await expect(
      verifyRuntimeArchiveChecksum(archivePath, { file: 'runtime.tar.gz' }, 'linux-x64')
    ).rejects.toThrow(/missing a valid sha256/i);
    await expect(
      verifyRuntimeArchiveChecksum(
        archivePath,
        { file: 'runtime.tar.gz', sha256: 'not-a-hash' },
        'linux-x64'
      )
    ).rejects.toThrow(/missing a valid sha256/i);
  });
});
