import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removePathWithIdentityFenceAsync } from '@main/utils/durablePathOperations';

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function crashScene(): Promise<{
  dir: string;
  targetPath: string;
  detachedPath: string;
  reservationPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'detached-resume-'));
  cleanup.push(dir);
  const targetPath = join(dir, 'team-a');
  const detachedPath = join(dir, '.team-a.deleting.resume');
  const reservationPath = join(dir, '.team-a.replacement.crashed');
  await mkdir(detachedPath);
  await writeFile(join(detachedPath, 'state.json'), '{}\n', 'utf8');
  await mkdir(reservationPath);
  await symlink(reservationPath, targetPath, 'junction');
  return { dir, targetPath, detachedPath, reservationPath };
}

function resumeOptions(detachedPath: string) {
  return {
    recursive: true,
    force: true,
    reservePublicDirectory: true,
    proofHooks: {
      detachedPath,
      onDetachedValidated: async () => undefined,
      onRemovalDurable: async () => undefined,
    },
  };
}

describe('resumed detached removal with a public reservation', () => {
  it('settles the dangling reservation junction left by a crash', async () => {
    const { targetPath, detachedPath, reservationPath } = await crashScene();

    const result = await removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath));

    expect(result).toBe('deleted');
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('republishes reservation contents written during the crash window', async () => {
    const { targetPath, detachedPath, reservationPath } = await crashScene();
    await writeFile(join(reservationPath, 'written-via-junction.json'), '{"kept":true}\n', 'utf8');

    const result = await removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath));

    expect(result).toBe('deleted');
    const republished = await lstat(targetPath);
    expect(republished.isDirectory()).toBe(true);
    expect(republished.isSymbolicLink()).toBe(false);
    await expect(readFile(join(targetPath, 'written-via-junction.json'), 'utf8')).resolves.toBe(
      '{"kept":true}\n'
    );
  });

  it('leaves an unrelated symlink at the public name untouched', async () => {
    const { dir, targetPath, detachedPath } = await crashScene();
    const unrelated = join(dir, 'unrelated-target');
    await mkdir(unrelated);
    await rm(targetPath);
    await symlink(unrelated, targetPath, 'junction');

    const result = await removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath));

    expect(result).toBe('deleted');
    const stillLinked = await lstat(targetPath);
    expect(stillLinked.isSymbolicLink()).toBe(true);
  });
});
