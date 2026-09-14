import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamWorkSyncRestorePending } from '@main/services/team/TeamWorkSyncRestorePending';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;
let manifestPath: string;
let shutdown: boolean;
let owner: TeamWorkSyncRestorePending;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-pending-'));
  manifestPath = path.join(root, 'manifest.json');
  shutdown = false;
  owner = new TeamWorkSyncRestorePending({
    getManifestPath: () => manifestPath,
    isShuttingDown: () => shutdown,
  });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      teamName: 'sandbox',
      identityId: 'id',
      status: 'active',
      firstBackupAt: '2026-09-10',
      lastBackupAt: '2026-09-10',
      fileStats: {},
      future: { keep: true },
    })
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('reuses durable generation after owner restart and preserves latest metadata on clear', async () => {
  const pending = await owner.begin('sandbox', 'id');
  const restarted = new TeamWorkSyncRestorePending({
    getManifestPath: () => manifestPath,
    isShuttingDown: () => false,
  });
  expect(await restarted.begin('sandbox', 'id')).toEqual(pending);
  const latest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  latest.future.extra = 'updated';
  await fs.writeFile(manifestPath, JSON.stringify(latest));
  await restarted.clear('sandbox', pending);
  const cleared = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  expect(cleared.workSyncRestorePending).toBeUndefined();
  expect(cleared.future).toEqual({ keep: true, extra: 'updated' });
});
it('refuses a stale generation without changing durable bytes', async () => {
  const pending = await owner.begin('sandbox', 'id');
  const raw = await fs.readFile(manifestPath, 'utf8');
  await expect(owner.clear('sandbox', { ...pending, generation: 'other' })).rejects.toThrow(
    'generation changed'
  );
  expect(await fs.readFile(manifestPath, 'utf8')).toBe(raw);
});
it('does not clear pending at shutdown or begin with another identity', async () => {
  const pending = await owner.begin('sandbox', 'id');
  const raw = await fs.readFile(manifestPath, 'utf8');
  await expect(owner.begin('sandbox', 'other')).rejects.toThrow('identity changed');
  shutdown = true;
  await expect(owner.clear('sandbox', pending)).rejects.toThrow('shutdown');
  expect(await fs.readFile(manifestPath, 'utf8')).toBe(raw);
});
