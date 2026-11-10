import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths.js';

export async function scanMemberWorkSyncNames(
  paths: MemberWorkSyncStorePaths,
  teamName: string,
  assertCurrent?: () => void
): Promise<string[]> {
  assertCurrent?.();
  const membersDir = join(paths.getTeamRootDir(teamName), 'members');
  assertCurrent?.();
  const entries = await readdir(membersDir, { withFileTypes: true }).catch(() => []);
  assertCurrent?.();
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const metaPath = join(membersDir, entry.name, 'member.meta.json');
    try {
      const raw = await readFile(metaPath, 'utf8');
      assertCurrent?.();
      const parsed = JSON.parse(raw) as { memberName?: unknown };
      if (typeof parsed.memberName === 'string' && parsed.memberName.trim()) {
        names.push(parsed.memberName.trim());
      }
    } catch {
      // Ignore malformed member storage dirs during repair.
    }
  }
  assertCurrent?.();
  return names;
}
