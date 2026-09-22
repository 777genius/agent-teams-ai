import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  openDirectoryBound,
  openOrCreateChildDirectory,
  readDescriptorBound,
  syncAndRevalidateDirectoryFilesAt,
} from '../../../../scripts/hosted-web/phase-10/state-compatibility/recovery-descriptor-io.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 10 recovery descriptor durability', () => {
  it('rejects an archive member hardlink before reading its bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase10-hardlink-member-'));
    roots.push(root);
    const member = join(root, 'member');
    await writeFile(member, 'sealed-member\n', { mode: 0o600 });
    await link(member, join(root, 'member.alias'));

    await expect(readDescriptorBound(member, 1024)).rejects.toThrow('recovery_file_invalid');
  });

  it('syncs and identity-revalidates an existing child before returning it for reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase10-existing-child-'));
    roots.push(root);
    const childPath = join(root, 'reused');
    await mkdir(childPath);
    const rootHandle = await openDirectoryBound(root);
    const sync = rootHandle.sync.bind(rootHandle);
    let syncCalls = 0;
    Object.defineProperty(rootHandle, 'sync', {
      value: async () => {
        await sync();
        syncCalls += 1;
        if (syncCalls === 1) {
          await rename(childPath, `${childPath}.replaced`);
          await mkdir(childPath);
        }
      },
    });
    try {
      await expect(openOrCreateChildDirectory(rootHandle, 'reused'))
        .rejects.toThrow('recovery_directory_entry_changed_during_sync');
      expect(syncCalls).toBe(1);
    } finally {
      await rootHandle.close();
    }
  });

  it('retains secret member descriptors and revalidates their contents after the final parent fsync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase10-secret-members-'));
    roots.push(root);
    const stagingPath = join(root, '.hosted-auth-secrets.restore-staging');
    const identityPath = join(stagingPath, 'identity.key');
    const expectedFiles = {
      'identity.key': 'journal-bound-identity\n',
      'personal-keyring.json': '{"keyringId":"journal-bound-keyring"}\n',
    };
    await mkdir(stagingPath);
    await writeFile(identityPath, expectedFiles['identity.key'], { mode: 0o600 });
    await writeFile(join(stagingPath, 'personal-keyring.json'), expectedFiles['personal-keyring.json'], { mode: 0o600 });
    const rootHandle = await openDirectoryBound(root);
    const sync = rootHandle.sync.bind(rootHandle);
    let finalParentFsync = false;
    Object.defineProperty(rootHandle, 'sync', {
      value: async () => {
        await sync();
        if (!finalParentFsync) {
          finalParentFsync = true;
          await writeFile(identityPath, 'tampered-after-parent-fsync\n', { mode: 0o600 });
        }
      },
    });
    try {
      await expect(syncAndRevalidateDirectoryFilesAt(
        rootHandle,
        '.hosted-auth-secrets.restore-staging',
        expectedFiles
      )).rejects.toThrow(/recovery_(?:file|directory)_entry_changed_during_sync/u);
      expect(finalParentFsync).toBe(true);
    } finally {
      await rootHandle.close();
    }
  });

  it('rejects a replacement secret member after the final parent fsync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phase10-secret-member-replacement-'));
    roots.push(root);
    const stagingPath = join(root, '.hosted-auth-secrets.restore-staging');
    const identityPath = join(stagingPath, 'identity.key');
    const expectedFiles = {
      'identity.key': 'journal-bound-identity\n',
      'personal-keyring.json': '{"keyringId":"journal-bound-keyring"}\n',
    };
    await mkdir(stagingPath);
    await writeFile(identityPath, expectedFiles['identity.key'], { mode: 0o600 });
    await writeFile(join(stagingPath, 'personal-keyring.json'), expectedFiles['personal-keyring.json'], { mode: 0o600 });
    const rootHandle = await openDirectoryBound(root);
    const sync = rootHandle.sync.bind(rootHandle);
    let finalParentFsync = false;
    Object.defineProperty(rootHandle, 'sync', {
      value: async () => {
        await sync();
        if (!finalParentFsync) {
          finalParentFsync = true;
          await rename(identityPath, join(root, 'identity.key.replaced'));
          await writeFile(identityPath, expectedFiles['identity.key'], { mode: 0o600 });
        }
      },
    });
    try {
      await expect(syncAndRevalidateDirectoryFilesAt(
        rootHandle,
        '.hosted-auth-secrets.restore-staging',
        expectedFiles
      )).rejects.toThrow(/recovery_(?:file|directory)_entry_changed_during_sync/u);
      expect(finalParentFsync).toBe(true);
    } finally {
      await rootHandle.close();
    }
  });
});
