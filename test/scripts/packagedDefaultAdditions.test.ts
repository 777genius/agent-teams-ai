import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { qualifyPackagedRuntimeAdditions } from '../../scripts/e2e/anthropic-compatible-status/packaged-default-additions';

const wrapper = 'opencode-console/opencode.exe';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('packaged runtime additions', () => {
  let root: string;
  let repo: string;
  let runtime: string;
  const original = new Map([['VERSION', digest('0.0.127')]]);

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'packaged-additions-'));
    repo = path.join(root, 'repo');
    runtime = path.join(root, 'app/resources/runtime');
    await mkdir(path.join(repo, 'resources/runtime/opencode-console'), { recursive: true });
    await mkdir(path.join(runtime, 'opencode-console'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const qualify = (extra: [string, string][], platform: NodeJS.Platform = 'win32') =>
    qualifyPackagedRuntimeAdditions(
      new Map(original),
      new Map([...original, ...extra]),
      repo,
      runtime,
      platform
    );

  async function stageWrapper(staged = 'compiled wrapper', bundled = staged) {
    await writeFile(path.join(repo, 'resources/runtime', wrapper), staged);
    await writeFile(path.join(runtime, wrapper), bundled);
    return digest(bundled);
  }

  it.each([
    'local-cli/unreviewed.js',
    'opencode-console/helper.dll',
    'opencode-console/opencode.real.path',
    '.gitkeep',
  ])('rejects the unreviewed bundled-only file %s', async (file) => {
    await expect(qualify([[file, digest('extra')]])).rejects.toThrow(
      `Unexpected file in packaged runtime: ${file}`
    );
  });

  it('records only the exact Windows wrapper with matching production-staged bytes', async () => {
    const hash = await stageWrapper();
    const additions = await qualify([[wrapper, hash]]);
    expect(additions).toEqual([
      {
        file: wrapper,
        staged: { path: path.join(repo, 'resources/runtime', wrapper), sha256: hash },
        bundled: { path: path.join(runtime, wrapper), sha256: hash },
      },
    ]);
  });

  it('rejects a modified or stale wrapper even at the allowlisted path', async () => {
    const hash = await stageWrapper('current compiled wrapper', 'stale wrapper');
    await expect(qualify([[wrapper, hash]])).rejects.toThrow(
      'Packaged addition differs from production-staged file'
    );
  });

  it('rejects a wrapper changed after the bundled inventory was taken', async () => {
    await stageWrapper();
    await expect(qualify([[wrapper, digest('earlier wrapper')]])).rejects.toThrow(
      'Package addition changed after inventory'
    );
  });

  it('does not allow the Windows wrapper on Linux', async () => {
    const hash = await stageWrapper();
    await expect(qualify([[wrapper, hash]], 'linux')).rejects.toThrow('Unexpected file');
  });

  it('requires a real production-staged counterpart', async () => {
    await writeFile(path.join(runtime, wrapper), 'wrapper');
    await expect(qualify([[wrapper, digest('wrapper')]])).rejects.toThrow('ENOENT');
  });

  it('rejects a symbolic-link staged counterpart', async () => {
    const target = path.join(root, 'external-wrapper');
    await writeFile(target, 'wrapper');
    await symlink(target, path.join(repo, 'resources/runtime', wrapper));
    await writeFile(path.join(runtime, wrapper), 'wrapper');
    await expect(qualify([[wrapper, digest('wrapper')]])).rejects.toThrow('regular file');
  });
});
