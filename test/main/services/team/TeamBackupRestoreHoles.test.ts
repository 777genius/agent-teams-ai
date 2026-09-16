import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamBackupRestoreService } from '@main/services/team/TeamBackupRestoreService';
import { expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ teams: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getTeamsBasePath: () => env.teams }));

it('restores missing generic files from fileStats without copying work-sync paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-holes-'));
  env.teams = path.join(root, 'teams');
  const backups = path.join(root, 'backups');
  const team = 'sandbox';
  const backupDir = path.join(backups, team);
  const liveDir = path.join(env.teams, team);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(path.join(backupDir, 'members', 'alice', '.member-work-sync'), {
    recursive: true,
  });
  await fs.mkdir(liveDir, { recursive: true });
  const config = JSON.stringify({ name: team, members: [], _backupIdentityId: 'id' });
  await fs.writeFile(path.join(backupDir, 'config.json'), config);
  await fs.writeFile(path.join(liveDir, 'config.json'), config);
  await fs.writeFile(path.join(backupDir, 'team.meta.json'), '{"ok":true}');
  await fs.writeFile(
    path.join(backupDir, 'members', 'alice', '.member-work-sync', 'journal.jsonl'),
    'secret'
  );
  const service = new TeamBackupRestoreService({
    loadManifest: async () => ({
      teamName: team,
      identityId: 'id',
      status: 'active',
      firstBackupAt: 'now',
      lastBackupAt: 'now',
      fileStats: {
        'config.json': { mtime: 1, size: 1 },
        'team.meta.json': { mtime: 1, size: 1 },
        'members/alice/.member-work-sync/journal.jsonl': { mtime: 1, size: 1 },
      },
    }),
    getBackupDir: () => backupDir,
    getSourcePathForRelPath: (_name, relPath) => path.join(liveDir, relPath),
    enumerateBackupFiles: async () => {
      throw new Error('must not walk the backup tree');
    },
  });
  try {
    expect(await service.restoreMissingGenericFromManifest(team)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(liveDir, 'team.meta.json'), 'utf8'))).toEqual({
      ok: true,
    });
    await expect(
      fs.readFile(path.join(liveDir, 'members', 'alice', '.member-work-sync', 'journal.jsonl'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not rewrite generic files that already exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-holes-exist-'));
  env.teams = path.join(root, 'teams');
  const backups = path.join(root, 'backups');
  const team = 'sandbox';
  const backupDir = path.join(backups, team);
  const liveDir = path.join(env.teams, team);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(liveDir, { recursive: true });
  const config = JSON.stringify({ name: team, members: [], _backupIdentityId: 'id' });
  await fs.writeFile(path.join(backupDir, 'config.json'), config);
  await fs.writeFile(path.join(liveDir, 'config.json'), config);
  await fs.writeFile(path.join(backupDir, 'team.meta.json'), '{"from":"backup"}');
  await fs.writeFile(path.join(liveDir, 'team.meta.json'), '{"from":"live"}');
  const service = new TeamBackupRestoreService({
    loadManifest: async () => ({
      teamName: team,
      identityId: 'id',
      status: 'active',
      firstBackupAt: 'now',
      lastBackupAt: 'now',
      fileStats: {
        'team.meta.json': { mtime: 1, size: 1 },
      },
    }),
    getBackupDir: () => backupDir,
    getSourcePathForRelPath: (_name, relPath) => path.join(liveDir, relPath),
    enumerateBackupFiles: async () => {
      throw new Error('must not walk the backup tree');
    },
  });
  try {
    expect(await service.restoreMissingGenericFromManifest(team)).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(liveDir, 'team.meta.json'), 'utf8'))).toEqual({
      from: 'live',
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('rewrites existing generic JSON that is corrupt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-holes-corrupt-'));
  env.teams = path.join(root, 'teams');
  const backups = path.join(root, 'backups');
  const team = 'sandbox';
  const backupDir = path.join(backups, team);
  const liveDir = path.join(env.teams, team);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(liveDir, { recursive: true });
  const config = JSON.stringify({ name: team, members: [], _backupIdentityId: 'id' });
  await fs.writeFile(path.join(backupDir, 'config.json'), config);
  await fs.writeFile(path.join(liveDir, 'config.json'), config);
  await fs.writeFile(path.join(backupDir, 'team.meta.json'), '{"ok":true}');
  await fs.writeFile(path.join(liveDir, 'team.meta.json'), '{');
  const service = new TeamBackupRestoreService({
    loadManifest: async () => ({
      teamName: team,
      identityId: 'id',
      status: 'active',
      firstBackupAt: 'now',
      lastBackupAt: 'now',
      fileStats: {
        'team.meta.json': { mtime: 1, size: 1 },
      },
    }),
    getBackupDir: () => backupDir,
    getSourcePathForRelPath: (_name, relPath) => path.join(liveDir, relPath),
    enumerateBackupFiles: async () => {
      throw new Error('must not walk the backup tree');
    },
  });
  try {
    expect(await service.restoreMissingGenericFromManifest(team)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(liveDir, 'team.meta.json'), 'utf8'))).toEqual({
      ok: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('restores a missing stop marker without republishing launch-state files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-holes-launch-'));
  env.teams = path.join(root, 'teams');
  const backups = path.join(root, 'backups');
  const team = 'sandbox';
  const backupDir = path.join(backups, team);
  const liveDir = path.join(env.teams, team);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(liveDir, { recursive: true });
  const config = JSON.stringify({ name: team, members: [], _backupIdentityId: 'id' });
  await fs.writeFile(path.join(backupDir, 'config.json'), config);
  await fs.writeFile(path.join(liveDir, 'config.json'), config);
  await fs.writeFile(path.join(backupDir, 'launch-state.json'), '{"phantom":true}');
  await fs.writeFile(path.join(backupDir, 'launch-summary.json'), '{"phantom":true}');
  await fs.writeFile(path.join(backupDir, 'launch-freshness.json'), '{"kind":"launch"}');
  await fs.writeFile(path.join(backupDir, 'launch-stopped.json'), '{"stopped":true}');
  const service = new TeamBackupRestoreService({
    loadManifest: async () => ({
      teamName: team,
      identityId: 'id',
      status: 'active',
      firstBackupAt: 'now',
      lastBackupAt: 'now',
      fileStats: {
        'launch-state.json': { mtime: 1, size: 1 },
        'launch-summary.json': { mtime: 1, size: 1 },
        'launch-freshness.json': { mtime: 1, size: 1 },
        'launch-stopped.json': { mtime: 1, size: 1 },
      },
    }),
    getBackupDir: () => backupDir,
    getSourcePathForRelPath: (_name, relPath) => path.join(liveDir, relPath),
    enumerateBackupFiles: async () => {
      throw new Error('must not walk the backup tree');
    },
  });
  try {
    expect(await service.restoreMissingGenericFromManifest(team)).toBe(true);
    await expect(fs.readFile(path.join(liveDir, 'launch-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.readFile(path.join(liveDir, 'launch-summary.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.readFile(path.join(liveDir, 'launch-freshness.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(liveDir, 'launch-stopped.json'), 'utf8')).toBe(
      '{"stopped":true}'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
