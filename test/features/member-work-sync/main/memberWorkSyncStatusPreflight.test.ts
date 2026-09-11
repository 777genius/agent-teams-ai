import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { archiveFileWithGenerations } from '@features/internal-storage/main';
import { statusToRecord } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { preflightMemberWorkSyncStatusSources } from '@features/member-work-sync/main/infrastructure/memberWorkSyncStatusPreflight';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

const identity = { teamName: 'sandbox', incarnation: 'inc-1' };
const time = '2026-09-10T00:00:00.000Z';
function status(memberName = 'alice'): MemberWorkSyncStatus {
  return {
    teamName: 'sandbox',
    memberName,
    state: 'needs_sync',
    evaluatedAt: time,
    diagnostics: [],
    agenda: {
      teamName: 'sandbox',
      memberName,
      generatedAt: time,
      fingerprint: 'agenda',
      items: [],
      diagnostics: [],
    },
  };
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe('status preparation preflight', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mws-preflight-'));
    paths = new MemberWorkSyncStorePaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const check = () => preflightMemberWorkSyncStatusSources({ paths, identity });

  it('does not materialize files while observing a fresh empty team', async () => {
    expect(await check()).toEqual({ historicalMemberKeys: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it('includes canonical, legacy and archived-only status history', async () => {
    await save(paths.getMemberStatusPath('sandbox', 'alice'), {
      schemaVersion: 2,
      status: status(),
    });
    await save(paths.getLegacyStatusPath('sandbox'), {
      schemaVersion: 1,
      members: { bob: status('bob') },
    });
    const carol = paths.getMemberStatusPath('sandbox', 'carol');
    await save(carol, { schemaVersion: 2, status: status('carol') });
    await archiveFileWithGenerations(carol);
    expect(await check()).toEqual({ historicalMemberKeys: ['alice', 'bob', 'carol'] });
  });

  it('inspects correctly encoded member directories', async () => {
    const memberName = 'Alice Smith';
    await save(paths.getMemberStatusPath('sandbox', memberName), {
      schemaVersion: 2,
      status: status(memberName),
    });
    expect(await check()).toEqual({ historicalMemberKeys: [paths.getMemberKey(memberName)] });
  });

  it.each(['{bad json', 'null', '{"schemaVersion":2,"status":{}}'])(
    'keeps corrupt canonical evidence before legacy fallback: %s',
    async (raw) => {
      const canonical = paths.getMemberStatusPath('sandbox', 'alice');
      await mkdir(dirname(canonical), { recursive: true });
      await writeFile(canonical, raw);
      await save(paths.getLegacyStatusPath('sandbox'), {
        schemaVersion: 1,
        members: { alice: status() },
      });
      await expect(check()).rejects.toThrow();
      expect(await readFile(canonical, 'utf8')).toBe(raw);
      expect(await readdir(dirname(canonical))).toEqual(['status.json']);
    }
  );

  it('does not filter a mismatched canonical owner away before checking legacy', async () => {
    await save(paths.getMemberStatusPath('sandbox', 'alice'), {
      schemaVersion: 2,
      status: status('bob'),
    });
    await expect(check()).rejects.toMatchObject({ reason: 'identity_mismatch' });
  });

  it('rejects archived state from another incarnation', async () => {
    const value = status();
    value.statusRevision = {
      incarnation: 'old-inc',
      lineageId: 'lineage',
      sequence: 4,
      nonce: 'nonce',
    };
    const canonical = paths.getMemberStatusPath('sandbox', 'alice');
    await save(canonical, { schemaVersion: 2, status: value });
    await archiveFileWithGenerations(canonical);
    await expect(check()).rejects.toMatchObject({ reason: 'incarnation_mismatch' });
  });

  it('treats old quarantine history as corruption rather than initial absence', async () => {
    const canonical = paths.getMemberStatusPath('sandbox', 'alice');
    await save(`${canonical}.invalid.100`, { previous: 'unknown' });
    await expect(check()).rejects.toMatchObject({ reason: 'corrupt' });
    expect(await readdir(dirname(canonical))).toEqual(['status.json.invalid.100']);
  });

  it('retains an unreadable canonical path', async () => {
    const canonical = paths.getMemberStatusPath('sandbox', 'alice');
    await mkdir(canonical, { recursive: true });
    await expect(check()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(await readdir(canonical)).toEqual([]);
  });

  it('checks primary raw payload ownership before any normalizing mapper', async () => {
    const row = statusToRecord(status());
    row.statusJson = JSON.stringify(status('bob'));
    await expect(
      preflightMemberWorkSyncStatusSources({ paths, identity, primaryStatuses: [row] })
    ).rejects.toMatchObject({ reason: 'identity_mismatch' });
  });
});
