import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listJsonMemberWorkSyncActiveFilePaths } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncActiveStatePurger';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { describe, expect, it } from 'vitest';

describe('listJsonMemberWorkSyncActiveFilePaths', () => {
  it('treats a missing members directory as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-purge-'));
    try {
      const files = await listJsonMemberWorkSyncActiveFilePaths(
        new MemberWorkSyncStorePaths(root),
        'team-a'
      );
      expect(files.some((file) => file.includes(`${join('members')}`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists per-member work-sync files when members exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-purge-'));
    try {
      await mkdir(join(root, 'team-a', 'members', 'bob', '.member-work-sync'), { recursive: true });
      await writeFile(
        join(root, 'team-a', 'members', 'bob', '.member-work-sync', 'status.json'),
        '{}'
      );
      const files = await listJsonMemberWorkSyncActiveFilePaths(
        new MemberWorkSyncStorePaths(root),
        'team-a'
      );
      expect(files).toContain(
        join(root, 'team-a', 'members', 'bob', '.member-work-sync', 'status.json')
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a members path that is not a directory as an empty purge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-purge-'));
    try {
      await mkdir(join(root, 'team-a'), { recursive: true });
      await writeFile(join(root, 'team-a', 'members'), 'not-a-directory');
      await expect(
        listJsonMemberWorkSyncActiveFilePaths(new MemberWorkSyncStorePaths(root), 'team-a')
      ).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
