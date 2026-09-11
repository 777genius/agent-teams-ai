import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { readBackupManifestStrict } from '@main/services/team/teamBackupManifest';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;
let manifestPath: string;
const valid = {
  teamName: 'sandbox',
  identityId: 'identity',
  status: 'active',
  firstBackupAt: '2026-09-10T00:00:00Z',
  lastBackupAt: '2026-09-10T00:00:00Z',
  fileStats: {},
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
  manifestPath = path.join(root, 'manifest.json');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  { status: ['active'] },
  { projectPath: 123 },
  { workSyncRestorePending: null },
  { workSyncRestorePending: { identityId: 'other', generation: 'r1' } },
  { workSyncRestorePending: { identityId: 'identity', generation: ' ' } },
  { fileStats: { item: { mtime: '0', size: 1 } } },
])('rejects malformed owner metadata %j without changing bytes', async (change) => {
  const raw = JSON.stringify({ ...valid, ...change });
  await fs.writeFile(manifestPath, raw);
  await expect(readBackupManifestStrict(manifestPath, 'sandbox')).rejects.toThrow();
  expect(await fs.readFile(manifestPath, 'utf8')).toBe(raw);
});

it('preserves matching pending generation and additive fields on read', async () => {
  const data = {
    ...valid,
    workSyncRestorePending: { identityId: 'identity', generation: 'r1' },
    future: { keep: true },
  };
  await fs.writeFile(manifestPath, JSON.stringify(data));
  expect(await readBackupManifestStrict(manifestPath, 'sandbox')).toEqual(data);
});
it('only treats ENOENT as absence', async () => {
  expect(await readBackupManifestStrict(manifestPath, 'sandbox')).toBeNull();
  await fs.mkdir(manifestPath);
  await expect(readBackupManifestStrict(manifestPath, 'sandbox')).rejects.toThrow();
});
