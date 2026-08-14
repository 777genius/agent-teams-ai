import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  descriptorAnchoredRead,
  descriptorAnchoredReplace,
  openTrustedDirectoryCapability,
} from '../HostedApprovalRuntimeDescriptorStorage';

const cleanup: string[] = [];
const run = promisify(execFile);

async function temporaryDirectory(label: string): Promise<string> {
  const path = join('/tmp', `approval-storage-${label}-${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('HostedApprovalRuntimeDescriptorStorage', () => {
  it('rejects traversal and both parent and final directory symlinks', async () => {
    const root = await temporaryDirectory('aliases');
    const realParent = join(root, 'real-parent');
    const team = join(realParent, 'team');
    await mkdir(team, { recursive: true, mode: 0o700 });
    await chmod(realParent, 0o700);
    await chmod(team, 0o700);
    const parentAlias = join(root, 'parent-alias');
    const finalAlias = join(root, 'team-alias');
    await symlink(realParent, parentAlias);
    await symlink(team, finalAlias);

    await expect(openTrustedDirectoryCapability(join(parentAlias, 'team'))).rejects.toThrow(
      'hosted-approval-runtime-directory-capability-invalid'
    );
    await expect(openTrustedDirectoryCapability(finalAlias)).rejects.toBeDefined();
    const capability = await openTrustedDirectoryCapability(team);
    try {
      await expect(descriptorAnchoredRead(capability, '../outside')).rejects.toThrow(
        'hosted-approval-runtime-descriptor-storage-unavailable'
      );
    } finally {
      await capability.handle.close();
    }
  });

  it.each(['symlink', 'hardlink', 'fifo', 'oversize'] as const)(
    'rejects an untrusted %s final entry without publishing',
    async (kind) => {
      const directory = await temporaryDirectory(kind);
      const target = join(directory, 'admission.json');
      const outside = join(directory, 'outside');
      await writeFile(outside, 'outside', { mode: 0o600 });
      if (kind === 'symlink') await symlink(outside, target);
      if (kind === 'hardlink') await link(outside, target);
      if (kind === 'fifo') await run('/usr/bin/mkfifo', [target]);
      if (kind === 'oversize') {
        await writeFile(target, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });
      }
      const capability = await openTrustedDirectoryCapability(directory);
      try {
        await expect(
          descriptorAnchoredReplace(capability, 'admission.json', '{}\n', {
            beforeRename: async () => undefined,
          })
        ).rejects.toThrow('hosted-approval-runtime-file-invalid');
      } finally {
        await capability.handle.close();
      }
      expect(await readFile(outside, 'utf8')).toBe('outside');
    }
  );

  it('detects a directory swap and writes to neither substituted directory', async () => {
    const root = await temporaryDirectory('swap-root');
    const directory = join(root, 'team');
    const moved = join(root, 'team-moved');
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const capability = await openTrustedDirectoryCapability(directory);
    await rename(directory, moved);
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await expect(
        descriptorAnchoredReplace(capability, 'admission.json', '{}\n', {
          beforeRename: async () => undefined,
        })
      ).rejects.toThrow('hosted-approval-runtime-directory-capability-invalid');
    } finally {
      await capability.handle.close();
    }
    await expect(readFile(join(directory, 'admission.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(moved, 'admission.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a target substitution after file fsync and before rename', async () => {
    const directory = await temporaryDirectory('target-race');
    const target = join(directory, 'admission.json');
    await writeFile(target, 'old\n', { mode: 0o600 });
    const capability = await openTrustedDirectoryCapability(directory);
    try {
      await expect(
        descriptorAnchoredReplace(capability, 'admission.json', 'new\n', {
          beforeRename: async () => {
            await writeFile(target, 'changed\n', { mode: 0o600 });
          },
        })
      ).rejects.toThrow('hosted-approval-runtime-target-changed');
    } finally {
      await capability.handle.close();
    }
    expect(await readFile(target, 'utf8')).toBe('changed\n');
  });
});
