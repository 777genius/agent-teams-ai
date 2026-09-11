import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => path.join(state.root, 'live'),
  getBackupsBasePath: () => path.join(state.root, 'backups'),
  getAppDataPath: () => path.join(state.root, 'app'),
  getTasksBasePath: () => path.join(state.root, 'tasks'),
}));

import { TeamBackupService } from '../../../../src/main/services/team/TeamBackupService';
import { loadTeamBackupStartupRegistry } from '../../../../src/main/services/team/TeamBackupStartupRegistry';

const services: TeamBackupService[] = [];
function service() {
  const owner = new TeamBackupService();
  services.push(owner);
  return owner;
}
function backups() {
  return path.join(state.root, 'backups');
}
async function writeManifest(name: string, pending = false) {
  const manifest = {
    teamName: name,
    identityId: `identity-${name}`,
    status: 'active',
    firstBackupAt: '2026-09-10',
    lastBackupAt: '2026-09-10',
    fileStats: {},
    ...(pending
      ? { workSyncRestorePending: { identityId: `identity-${name}`, generation: 'g1' } }
      : {}),
  };
  const dir = path.join(backups(), 'teams', name);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

describe('strict backup startup registry', () => {
  beforeEach(async () => {
    state.root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backup-startup-'));
  });
  afterEach(async () => {
    services.splice(0).forEach((owner) => owner.dispose());
    vi.restoreAllMocks();
    await fs.promises.rm(state.root, { recursive: true, force: true });
  });

  it('does not publish registry when shutdown interrupts startup discovery', async () => {
    const registryPath = path.join(backups(), 'registry.json');
    let release!: () => void;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const original = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === registryPath) {
        reached();
        await barrier;
      }
      return original(...args);
    });
    const owner = service();
    const initialization = owner.initialize();
    const outcome = initialization.catch((error) => error);
    try {
      await entered;
      owner.runShutdownBackupSync();
      release();
      expect(await outcome).toBeInstanceOf(Error);
      await expect(original(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((owner as unknown as { periodicTimer: unknown }).periodicTimer).toBeNull();
    } finally {
      release();
      await outcome;
    }
  });

  it('accepts a completely missing backup root', async () => {
    await expect(service().initialize()).resolves.toBeUndefined();
  });

  it.each([
    '{broken',
    '{"version":2,"teams":{}}',
    '{"version":1,"teams":null}',
    '{"version":1,"teams":{"a":{"identityId":"i"}}}',
  ])('rejects malformed registry startup: %s', async (raw) => {
    await fs.promises.mkdir(backups(), { recursive: true });
    await fs.promises.writeFile(path.join(backups(), 'registry.json'), raw);
    const owner = service();
    await expect(owner.initialize()).rejects.toThrow();
    owner.runShutdownBackupSync();
    expect(await fs.promises.readFile(path.join(backups(), 'registry.json'), 'utf8')).toBe(raw);
  });

  it.each(['registry', 'manifest'] as const)(
    'rejects whitespace-padded identity from %s before publishing roster',
    async (source) => {
      const manifest = await writeManifest('sandbox-canonical');
      const padded = { ...manifest, identityId: ' padded-identity ' };
      if (source === 'registry') {
        await fs.promises.writeFile(
          path.join(backups(), 'registry.json'),
          JSON.stringify({
            version: 1,
            teams: { 'sandbox-canonical': padded },
          })
        );
      } else {
        await fs.promises.writeFile(
          path.join(backups(), 'teams/sandbox-canonical/manifest.json'),
          JSON.stringify(padded)
        );
      }
      await expect(service().initialize()).rejects.toThrow();
    }
  );

  it('recovers an unlisted pending team when registry is missing and retains its closure', async () => {
    const manifest = await writeManifest('sandbox-pending', true);
    const owner = service();
    const gate = new MemberWorkSyncTeamOperationGate();
    const participant = {
      prepare: vi.fn(async () => ({ importAndVerify: async () => undefined })),
    };
    owner.configureWorkSyncRestore(gate, participant);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await owner.initialize(); // Missing config fails this known team locally, preserving pending.
    await expect(gate.run('sandbox-pending', async () => true)).rejects.toThrow();
    expect(participant.prepare).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        await fs.promises.readFile(
          path.join(backups(), 'teams/sandbox-pending/manifest.json'),
          'utf8'
        )
      ).workSyncRestorePending
    ).toEqual(manifest.workSyncRestorePending);
  });

  it('persists discovered pending teams before another team backup replaces the registry', async () => {
    const pendingTeam = 'sandbox-pending-b';
    const activeTeam = 'sandbox-active-a';
    const manifest = await writeManifest(pendingTeam, true);
    const owner = service();
    const gate = new MemberWorkSyncTeamOperationGate();
    const participant = {
      prepare: vi.fn(async () => ({ importAndVerify: async () => undefined })),
    };
    owner.configureWorkSyncRestore(gate, participant);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await owner.initialize();
    const registryPath = path.join(backups(), 'registry.json');
    expect(
      JSON.parse(await fs.promises.readFile(registryPath, 'utf8')).teams[pendingTeam]
    ).toMatchObject({ identityId: manifest.identityId });
    const activeDir = path.join(state.root, 'live', activeTeam);
    await fs.promises.mkdir(activeDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(activeDir, 'config.json'),
      JSON.stringify({ name: activeTeam, members: [] })
    );
    await owner.backupTeam(activeTeam);
    const afterBackup = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
    expect(Object.keys(afterBackup.teams).sort()).toEqual([activeTeam, pendingTeam]);
    await fs.promises.writeFile(
      path.join(backups(), 'teams', pendingTeam, 'config.json'),
      JSON.stringify({
        name: pendingTeam,
        members: [],
        _backupIdentityId: manifest.identityId,
      })
    );
    expect(await owner.restoreIfNeeded()).toContain(pendingTeam);
    expect(participant.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: pendingTeam })
    );
    await expect(gate.run(pendingTeam, async () => true)).resolves.toBe(true);
    expect(
      Object.keys(JSON.parse(await fs.promises.readFile(registryPath, 'utf8')).teams).sort()
    ).toEqual([activeTeam, pendingTeam]);
  });

  it('rejects incomplete directory enumeration', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('sandbox EIO'), { code: 'EIO' })
    );
    const owner = service();
    await expect(owner.initialize()).rejects.toThrow('sandbox EIO');
    owner.runShutdownBackupSync();
    await expect(fs.promises.readFile(path.join(backups(), 'registry.json'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });

  it('rejects an unknown corrupted manifest even with a valid registry', async () => {
    await writeManifest('sandbox-unknown');
    await fs.promises.writeFile(path.join(backups(), 'registry.json'), '{"version":1,"teams":{}}');
    await fs.promises.writeFile(
      path.join(backups(), 'teams/sandbox-unknown/manifest.json'),
      '{broken'
    );
    await expect(service().initialize()).rejects.toThrow();
  });

  it('discovers unlisted teams while preserving existing registry ownership', async () => {
    await writeManifest('sandbox-known');
    await writeManifest('sandbox-new', true);
    const known = {
      teamName: 'sandbox-known',
      identityId: 'replacement',
      status: 'deleted_by_user',
      lastBackupAt: '2026-09-11',
      deletedByUserAt: '2026-09-11',
    };
    await fs.promises.writeFile(
      path.join(backups(), 'registry.json'),
      JSON.stringify({
        version: 1,
        teams: { 'sandbox-known': known },
      })
    );
    await fs.promises.writeFile(
      path.join(backups(), 'teams/sandbox-known/manifest.json'),
      '{broken'
    );
    const registry = await loadTeamBackupStartupRegistry(backups());
    expect(registry.teams['sandbox-known']).toEqual(known);
    expect(registry.teams['sandbox-new']?.identityId).toBe('identity-sandbox-new');
  });
});
