import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MemberWorkSyncStorePaths pending replay detection', () => {
  it('treats journal index and member reports as replayable without the controller file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mws-paths-'));
    roots.push(root);
    const paths = new MemberWorkSyncStorePaths(root);
    expect(paths.hasReplayablePendingReports('team-a')).toBe(false);

    mkdirSync(join(root, 'team-a', '.member-work-sync', 'indexes'), { recursive: true });
    writeFileSync(paths.getPendingReportsIndexPath('team-a'), '{}\n');
    expect(paths.hasReplayablePendingReports('team-a')).toBe(true);

    const other = new MemberWorkSyncStorePaths(root);
    mkdirSync(other.getMemberWorkSyncDir('team-b', 'bob'), { recursive: true });
    expect(other.hasReplayablePendingReports('team-b')).toBe(false);
    writeFileSync(other.getMemberReportsPath('team-b', 'bob'), '{}\n');
    expect(other.hasReplayablePendingReports('team-b')).toBe(true);
  });
});
