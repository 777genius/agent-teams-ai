import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BackupManifest,
  getBackupManifestPath,
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

  it('reports the team whose manifest could not be persisted', () => {
    // The shutdown backup copies the files and updates the registry before it
    // saves the manifest, so a write that fails silently leaves a backup that
    // restores from stale ownership and stale file stats with nothing said.
    const backupDir = path.join(tempRoot, 'blocked');
    fs.writeFileSync(backupDir, 'a file where the backup directory belongs');

    expect(() => writeBackupManifestSync(backupDir, buildManifest('blocked-team'))).not.toThrow();

    expect(console.warn).toHaveBeenCalledWith(
      '[TeamBackupService]',
      expect.stringContaining('Failed to save manifest for blocked-team')
    );
    vi.mocked(console.warn).mockClear();
  });
});
