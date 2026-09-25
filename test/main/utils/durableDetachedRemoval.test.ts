import * as fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDurablePathIdentity, removePathWithIdentityFenceAsync } from '@main/utils/durablePathOperations';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scene() {
  const directory = await mkdtemp(join(tmpdir(), 'deletion-authority-'));
  cleanup.push(directory);
  const targetPath = join(directory, 'team');
  const detachedPath = join(directory, '.team.deleting.transaction');
  await mkdir(targetPath);
  await writeFile(join(targetPath, 'original.json'), 'A');
  const expected = getDurablePathIdentity(await lstat(targetPath));
  return { directory, targetPath, detachedPath, expected };
}

function hooks(detachedPath: string, expected?: ReturnType<typeof getDurablePathIdentity>) {
  let state: 'none' | 'authorized' | 'detached' | 'removed' = 'none';
  const onRemovalDurable = vi.fn(async () => { state = 'removed'; });
  return {
    detachedPath,
    assertWriterAdmission: vi.fn(async () => undefined),
    onRemovalPrepared: vi.fn(async (_path: string, identity: ReturnType<typeof getDurablePathIdentity>) => {
      if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.birthtimeMs !== expected.birthtimeMs)) {
        throw new Error('operator_required: expected public identity changed');
      }
      state = 'authorized';
    }),
    onDetachedValidated: vi.fn(async () => {
      if (state !== 'authorized' && state !== 'detached') throw new Error('operator_required: missing prepared receipt');
      state = 'detached';
    }),
    onRemovalDurable,
    state: () => state,
  };
}

describe('permanent deletion authority on real paths', () => {
  it('requires writer admission before the first pathname mutation', async () => {
    const { targetPath, detachedPath } = await scene();
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true,
      proofHooks: { detachedPath, onDetachedValidated: async () => undefined, onRemovalDurable: async () => undefined },
    })).rejects.toThrow('operator_required: permanent deletion writer admission is unavailable');
    expect(await readFile(join(targetPath, 'original.json'), 'utf8')).toBe('A');
  });

  it('does not adopt B substituted before the first public identity read', async () => {
    const { directory, targetPath, detachedPath, expected } = await scene();
    const original = join(directory, 'original-a');
    const replacement = join(directory, 'replacement-b');
    await mkdir(replacement);
    await writeFile(join(replacement, 'b.json'), 'B');
    const realLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (candidate, options) => {
      if (String(candidate) === targetPath) {
        await rename(targetPath, original);
        await rename(replacement, targetPath);
      }
      return realLstat(candidate, options);
    });
    const proof = hooks(detachedPath, expected);
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true, proofHooks: proof,
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    expect(proof.onRemovalPrepared).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await readFile(join(targetPath, 'b.json'), 'utf8')).toBe('B');
    expect(await readFile(join(original, 'original.json'), 'utf8')).toBe('A');
    expect(proof.onRemovalDurable).not.toHaveBeenCalled();
  });

  it('retains ambiguous held B without calling rmdir', async () => {
    const { directory, targetPath, detachedPath } = await scene();
    const held = join(directory, '.detached-reservation-reconcile-ambiguous');
    await mkdir(held);
    await mkdir(join(held, 'reservation'));
    await writeFile(join(held, 'reservation', 'b.json'), 'B');
    const rmdir = vi.spyOn(fs.promises, 'rmdir');
    const proof = hooks(detachedPath);
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true, proofHooks: proof,
    })).rejects.toThrow('operator_required: ambiguous detached reservation retained');
    expect(await readFile(join(held, 'reservation', 'b.json'), 'utf8')).toBe('B');
    expect(await readFile(join(targetPath, 'original.json'), 'utf8')).toBe('A');
    expect(rmdir).not.toHaveBeenCalled();
    expect(proof.onRemovalDurable).not.toHaveBeenCalled();
  });

  it('leaves the public tree in place before any validation or detach', async () => {
    const { targetPath, detachedPath, expected } = await scene();
    const proof = hooks(detachedPath, expected);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    const validateDetached = vi.fn(async () => true);
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true, proofHooks: proof,
      validateDetached,
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    expect(renameSpy).not.toHaveBeenCalled();
    expect(validateDetached).not.toHaveBeenCalled();
    expect(proof.onRemovalPrepared).not.toHaveBeenCalled();
    expect(await readFile(join(targetPath, 'original.json'), 'utf8')).toBe('A');
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses recursive removal before publishing a quarantine path', async () => {
    const { targetPath, detachedPath, expected } = await scene();
    const proof = hooks(detachedPath, expected);
    const rmSpy = vi.spyOn(fs.promises, 'rm');
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true, proofHooks: proof,
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    expect(proof.state()).toBe('none');
    expect(proof.onRemovalPrepared).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
    expect(await readFile(join(targetPath, 'original.json'), 'utf8')).toBe('A');
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a removal receipt when no identity-bound remover exists', async () => {
    const { targetPath, detachedPath, expected } = await scene();
    const proof = hooks(detachedPath, expected);
    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true, force: true, reservePublicDirectory: true, proofHooks: proof,
      validateDetached: async (_path, identity) => identity.ino === expected.ino,
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    expect(proof.state()).toBe('none');
    expect(proof.onRemovalDurable).not.toHaveBeenCalled();
    expect(await readFile(join(targetPath, 'original.json'), 'utf8')).toBe('A');
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
