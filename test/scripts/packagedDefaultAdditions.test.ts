import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { qualifyPackagedRuntimeAdditions } from '../../scripts/e2e/anthropic-compatible-status/packaged-default-additions';

const wrapper = 'opencode-console/opencode.exe';
const teammate = 'teammate-console/teammate.exe';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('packaged runtime additions', () => {
  let root: string;
  let repo: string;
  let runtime: string;
  const original = new Map([['VERSION', digest('0.0.127')]]);

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'packaged-additions-')));
    repo = path.join(root, 'repo');
    runtime = path.join(root, 'app/resources/runtime');
    for (const name of ['opencode-console', 'teammate-console']) {
      await mkdir(path.join(repo, 'resources/runtime', name), { recursive: true });
      await mkdir(path.join(runtime, name), { recursive: true });
    }
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

  async function stageWrapper(staged = 'compiled wrapper', bundled = staged, file = wrapper) {
    await writeFile(path.join(repo, 'resources/runtime', file), staged);
    await writeFile(path.join(runtime, file), bundled);
    return digest(bundled);
  }
  async function stageBoth(): Promise<[string, string][]> {
    return [
      [wrapper, await stageWrapper()],
      [teammate, await stageWrapper('compiled teammate', 'compiled teammate', teammate)],
    ];
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

  it('records exactly both Windows wrappers with matching production-staged bytes', async () => {
    const staged = await stageBoth();
    const additions = await qualify(staged);
    expect(additions).toEqual(staged.map(([file, sha256]) => ({
      file,
      staged: { path: path.join(repo, 'resources/runtime', file), sha256 },
      bundled: { path: path.join(runtime, file), sha256 },
    })));
  });

  it.each([wrapper, teammate])('requires Windows wrapper %s in the package', async (missing) => {
    const staged = await stageBoth();
    await expect(qualify(staged.filter(([file]) => file !== missing))).rejects.toThrow(
      `Required Windows runtime wrapper missing: ${missing}`
    );
  });

  it('does not require a Windows-only addition in a Linux package', async () => {
    await expect(qualify([], 'linux')).resolves.toEqual([]);
  });

  it('leaves an archive-owned wrapper under the original strict comparison', async () => {
    const hash = digest('public archive wrapper');
    await writeFile(path.join(runtime, wrapper), 'public archive wrapper');
    const teammateHash = await stageWrapper('archived teammate', 'archived teammate', teammate);
    const archive = new Map([...original, [wrapper, hash], [teammate, teammateHash]]);
    await expect(
      qualifyPackagedRuntimeAdditions(archive, new Map(archive), repo, runtime, 'win32')
    ).resolves.toEqual([]);
  });

  it('rejects a modified or stale wrapper even at the allowlisted path', async () => {
    const hash = await stageWrapper('current compiled wrapper', 'stale wrapper');
    const otherHash = await stageWrapper('teammate', 'teammate', teammate);
    await expect(qualify([[wrapper, hash], [teammate, otherHash]])).rejects.toThrow(
      'Packaged addition differs from production-staged file'
    );
  });

  it('rejects a wrapper changed after the bundled inventory was taken', async () => {
    await stageWrapper();
    const otherHash = await stageWrapper('teammate', 'teammate', teammate);
    await expect(qualify([[wrapper, digest('earlier wrapper')], [teammate, otherHash]])).rejects.toThrow(
      'Package addition changed after inventory'
    );
  });

  it('does not allow the Windows wrapper on Linux', async () => {
    const hash = await stageWrapper();
    await expect(qualify([[wrapper, hash]], 'linux')).rejects.toThrow('Unexpected file');
  });

  it('requires a real production-staged counterpart', async () => {
    await writeFile(path.join(runtime, wrapper), 'wrapper');
    const otherHash = await stageWrapper('teammate', 'teammate', teammate);
    await expect(qualify([[wrapper, digest('wrapper')], [teammate, otherHash]])).rejects.toThrow('ENOENT');
  });

  it('rejects a symbolic-link staged counterpart', async () => {
    const target = path.join(root, 'external-wrapper');
    await writeFile(target, 'wrapper');
    await symlink(target, path.join(repo, 'resources/runtime', wrapper));
    await writeFile(path.join(runtime, wrapper), 'wrapper');
    const otherHash = await stageWrapper('teammate', 'teammate', teammate);
    await expect(qualify([[wrapper, digest('wrapper')], [teammate, otherHash]])).rejects.toThrow('regular file');
  });
});
