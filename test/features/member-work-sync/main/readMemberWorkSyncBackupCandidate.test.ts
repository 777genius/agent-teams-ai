import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMemberWorkSyncBackupCandidate } from '@features/member-work-sync/main/infrastructure/readMemberWorkSyncBackupCandidate';
import { expect, it } from 'vitest';

it.each(['clean', 'dirty'] as const)(
  'preserves %s provenance, secret bytes and backup source',
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-backup-reader-'));
    const dir = join(root, 'sandbox', '.member-work-sync');
    await mkdir(dir, { recursive: true });
    const secret = JSON.stringify({ schemaVersion: 1, secret: 'x'.repeat(32) });
    const snapshot = {
      statuses: [],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
      filesToArchive: [],
    };
    const raw = JSON.stringify({
      schemaVersion: 1,
      state,
      incarnation: 'id',
      updatedAt: '2026-09-10T00:00:00Z',
      snapshot,
    });
    await writeFile(join(dir, 'sqlite-fallback-replica.json'), raw);
    await writeFile(join(dir, 'report-token-secret.json'), secret);
    try {
      const result = await readMemberWorkSyncBackupCandidate({
        backupTeamsRoot: root,
        teamName: 'sandbox',
        incarnation: 'id',
      });
      expect(result.replica.state).toBe(state);
      expect(result.secretJson).toBe(secret);
      expect(result.history.filesToArchive).toEqual([]);
      expect(await readFile(join(dir, 'sqlite-fallback-replica.json'), 'utf8')).toBe(raw);
      expect((await readdir(dir)).sort()).toEqual([
        'report-token-secret.json',
        'sqlite-fallback-replica.json',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each([true, false])(
  'validates bound secret identity and preserves source (matching=%s)',
  async (matching) => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-backup-reader-'));
    const dir = join(root, 'sandbox', '.member-work-sync');
    await mkdir(dir, { recursive: true });
    const raw = JSON.stringify({
      schemaVersion: 2,
      teamName: 'sandbox',
      incarnation: matching ? 'id' : 'foreign',
      secret: 'x'.repeat(32),
    });
    const path = join(dir, 'report-token-secret.json');
    await writeFile(path, raw);
    try {
      const result = readMemberWorkSyncBackupCandidate({
        backupTeamsRoot: root,
        teamName: 'sandbox',
        incarnation: 'id',
      });
      if (matching) expect((await result).secretJson).toBe(raw);
      else await expect(result).rejects.toThrow('identity mismatch');
      expect(await readFile(path, 'utf8')).toBe(raw);
      expect(await readdir(dir)).toEqual(['report-token-secret.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
