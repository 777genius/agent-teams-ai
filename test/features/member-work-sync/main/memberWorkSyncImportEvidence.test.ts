import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { archiveFileWithGenerations } from '@features/internal-storage/main';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { readMemberWorkSyncSafetyJson } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSafetyJson';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('import preserves report and outbox evidence on read failure', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let store: JsonMemberWorkSyncStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mws-import-evidence-'));
    paths = new MemberWorkSyncStorePaths(root);
    store = new JsonMemberWorkSyncStore(paths);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = (kind: string) => {
    switch (kind) {
      case 'legacy reports':
        return paths.getLegacyPendingReportsPath('sandbox');
      case 'legacy outbox':
        return paths.getLegacyOutboxPath('sandbox');
      case 'member reports':
        return paths.getMemberReportsPath('sandbox', 'alice');
      default:
        return paths.getMemberOutboxPath('sandbox', 'alice');
    }
  };
  describe.each(['legacy reports', 'legacy outbox', 'member reports', 'member outbox'])(
    '%s',
    (kind) => {
      it.each(['{broken', 'null', '{"schemaVersion":2,"items":[],"intents":[]}'])(
        'preserves corrupt active source %s',
        async (raw) => {
          const path = source(kind);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, raw);
          await expect(store.readSnapshotForImport('sandbox')).rejects.toMatchObject({
            reason: 'corrupt',
          });
          expect(await readFile(path, 'utf8')).toBe(raw);
          expect(
            (await readdir(dirname(path))).filter((name) => name.includes('.invalid.'))
          ).toEqual([]);
        }
      );
      it('preserves corrupt archived evidence', async () => {
        const path = source(kind);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{broken');
        await archiveFileWithGenerations(path);
        const before = await readdir(dirname(path));
        await expect(store.readArchivedSnapshotForImport('sandbox')).rejects.toMatchObject({
          reason: 'corrupt',
        });
        expect(await readdir(dirname(path))).toEqual(before);
        const archive = before.find((name) => name.includes('.pre-sqlite'))!;
        expect(await readFile(join(dirname(path), archive), 'utf8')).toBe('{broken');
      });
      it('does not treat an unreadable active payload as empty', async () => {
        const path = source(kind);
        await mkdir(path, { recursive: true });
        await expect(store.readSnapshotForImport('sandbox')).rejects.toMatchObject({
          reason: 'unavailable',
        });
        expect(await readdir(path)).toEqual([]);
      });
    }
  );
  it('distinguishes an absent optional source from an archive that disappeared after discovery', async () => {
    const path = join(root, 'missing.json');
    const guard = (value: unknown): value is string[] => Array.isArray(value);
    await expect(readMemberWorkSyncSafetyJson(path, guard, [])).resolves.toEqual([]);
    await expect(readMemberWorkSyncSafetyJson(path, guard, [], false)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(await readdir(root)).toEqual([]);
  });
});
