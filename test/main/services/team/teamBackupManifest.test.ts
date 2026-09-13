import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BackupManifest,
  getBackupManifestPath,
  readBackupManifestStrict,
  readBackupManifestSync,
  writeBackupManifestSync,
} from '@main/services/team/teamBackupManifest';

let tempRoot = '';

function buildManifest(teamName = 'demo', overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    teamName,
    identityId: 'identity-1',
    status: 'active',
    firstBackupAt: '2026-01-01T00:00:00.000Z',
    lastBackupAt: '2026-01-01T00:00:00.000Z',
    fileStats: { 'config.json': { mtime: 1, size: 2 } },
    ...overrides,
  };
}

describe('writeBackupManifestSync', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-backup-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('persists a manifest a restore can read back', () => {
    const backupDir = path.join(tempRoot, 'demo');

    writeBackupManifestSync(backupDir, buildManifest());

    expect(fs.existsSync(getBackupManifestPath(backupDir))).toBe(true);
    expect(readBackupManifestSync(backupDir)).toEqual(buildManifest());
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('persists a deleted-by-user manifest with its deletion timestamp', () => {
    const backupDir = path.join(tempRoot, 'deleted');
    const deleted = buildManifest('deleted', {
      status: 'deleted_by_user',
      deletedByUserAt: '2026-02-01T00:00:00.000Z',
      projectPath: 'D:/projects/deleted',
      displayName: 'Deleted team',
    });

    writeBackupManifestSync(backupDir, deleted);

    const restored = readBackupManifestSync(backupDir);
    expect(restored).toEqual(deleted);
    expect(restored?.status).toBe('deleted_by_user');
    expect(restored?.deletedByUserAt).toBe('2026-02-01T00:00:00.000Z');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reports and propagates the team whose manifest could not be persisted', () => {
    const backupDir = path.join(tempRoot, 'blocked');
    fs.writeFileSync(backupDir, 'a file where the backup directory belongs');

    expect(() => writeBackupManifestSync(backupDir, buildManifest('blocked-team'))).toThrow();

    expect(console.warn).toHaveBeenCalledWith(
      '[TeamBackupService]',
      expect.stringContaining('Failed to save manifest for blocked-team')
    );
    vi.mocked(console.warn).mockClear();
  });
});

describe('readBackupManifestStrict', () => {
  let root: string;
  let manifestPath: string;
  const valid = {
    teamName: 'sandbox',
    identityId: 'identity',
    status: 'active' as const,
    firstBackupAt: '2026-09-10T00:00:00Z',
    lastBackupAt: '2026-09-10T00:00:00Z',
    fileStats: {},
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manifest-strict-'));
    manifestPath = path.join(root, 'manifest.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
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
    fs.writeFileSync(manifestPath, raw);
    await expect(readBackupManifestStrict(manifestPath, 'sandbox')).rejects.toThrow();
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(raw);
  });

  it('preserves matching pending generation and additive fields on read', async () => {
    const data = {
      ...valid,
      workSyncRestorePending: { identityId: 'identity', generation: 'r1' },
      future: { keep: true },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(data));
    expect(await readBackupManifestStrict(manifestPath, 'sandbox')).toEqual(data);
  });

  it('only treats ENOENT as absence', async () => {
    expect(await readBackupManifestStrict(manifestPath, 'sandbox')).toBeNull();
    fs.mkdirSync(manifestPath);
    await expect(readBackupManifestStrict(manifestPath, 'sandbox')).rejects.toThrow();
  });
});
