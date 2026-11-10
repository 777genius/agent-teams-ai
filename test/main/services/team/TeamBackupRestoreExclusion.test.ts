import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamBackupRestoreService } from '@main/services/team/TeamBackupRestoreService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackupManifest } from '@main/services/team/teamBackupManifest';

const paths = vi.hoisted(() => ({ teamsBase: '' }));
vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => paths.teamsBase,
}));
vi.mock('@main/services/team/TeamConfigReader', () => ({
  TeamConfigReader: { invalidateTeam: vi.fn() },
}));

const teamName = 'sandbox-restore';
const config = JSON.stringify({ name: teamName, _backupIdentityId: 'sandbox-identity' });
const protectedPaths = [
  '.member-work-sync/authority.sqlite',
  '.member-work-sync/status.json',
  'members/bob/.member-work-sync/continuity.json',
];
const manifest: BackupManifest = {
  teamName,
  identityId: 'sandbox-identity',
  status: 'active',
  firstBackupAt: '2026-09-10T00:00:00.000Z',
  lastBackupAt: '2026-09-10T00:00:00.000Z',
  fileStats: {},
};

describe('privileged generic backup restore exclusions', () => {
  let sandbox: string;
  let backupDir: string;
  let sourceDir: string;
  let files: string[];
  let service: TeamBackupRestoreService;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'team-restore-exclusion-'));
    paths.teamsBase = path.join(sandbox, 'teams');
    backupDir = path.join(sandbox, 'backup');
    sourceDir = path.join(paths.teamsBase, teamName);
    files = ['config.json', 'notes.json', ...protectedPaths];
    for (const relativePath of files) {
      const file = path.join(backupDir, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, relativePath === 'config.json' ? config : '{"restored":true}');
    }
    await fs.mkdir(sourceDir, { recursive: true });
    service = new TeamBackupRestoreService({
      loadManifest: async () => manifest,
      getBackupDir: () => backupDir,
      getSourcePathForRelPath: (_team, relativePath) => path.join(sourceDir, relativePath),
      enumerateBackupFiles: async () => files,
    });
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it.each(['full', 'partial'] as const)(
    '%s restores generic files without publishing protected data',
    async (mode) => {
      if (mode === 'partial') await fs.writeFile(path.join(sourceDir, 'config.json'), config);
      expect(await service.restoreGenericTeamPrivileged(teamName)).toBe(true);
      expect(await fs.readFile(path.join(sourceDir, 'config.json'), 'utf8')).toBe(config);
      expect(await fs.readFile(path.join(sourceDir, 'notes.json'), 'utf8')).toBe(
        '{"restored":true}'
      );
      for (const relativePath of protectedPaths) {
        await expect(fs.stat(path.join(sourceDir, relativePath))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    }
  );

  it.each(['full', 'partial'] as const)(
    '%s rejects traversal before publishing any generic file',
    async (mode) => {
      if (mode === 'partial') await fs.writeFile(path.join(sourceDir, 'config.json'), config);
      files.push('members/../.member-work-sync/authority.sqlite');
      await expect(service.restoreGenericTeamPrivileged(teamName)).rejects.toThrow(
        'Invalid backup relative path'
      );
      expect(await fs.readdir(sourceDir)).toEqual(mode === 'partial' ? ['config.json'] : []);
    }
  );

  it('keeps existing protected content unchanged', async () => {
    const destination = path.join(sourceDir, protectedPaths[0]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'existing-authority');
    expect(await service.restoreGenericTeamPrivileged(teamName)).toBe(true);
    expect(await fs.readFile(destination, 'utf8')).toBe('existing-authority');
  });

  it('preserves source identity mismatch rejection', async () => {
    const replacement = JSON.stringify({ name: teamName, _backupIdentityId: 'replacement' });
    await fs.writeFile(path.join(sourceDir, 'config.json'), replacement);
    expect(await service.restoreGenericTeamPrivileged(teamName)).toBe(false);
    expect(await fs.readdir(sourceDir)).toEqual(['config.json']);
    expect(await fs.readFile(path.join(sourceDir, 'config.json'), 'utf8')).toBe(replacement);
  });

  it('preserves backup identity mismatch rejection before config publication', async () => {
    await fs.writeFile(
      path.join(backupDir, 'config.json'),
      JSON.stringify({ name: teamName, _backupIdentityId: 'wrong-backup' })
    );
    await expect(service.restoreGenericTeamPrivileged(teamName)).rejects.toThrow(
      'Backup config identity does not match its manifest'
    );
    expect(await fs.readdir(sourceDir)).toEqual([]);
  });

  it('retains legacy restoreTeam protected-file behavior until owner migration', async () => {
    expect(await service.restoreTeam(teamName)).toBe(true);
    for (const relativePath of protectedPaths) {
      expect(await fs.readFile(path.join(sourceDir, relativePath), 'utf8')).toBe(
        '{"restored":true}'
      );
    }
  });
});
