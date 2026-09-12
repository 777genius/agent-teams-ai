import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MemberWorkSyncTeamOperationGate,
  MemberWorkSyncTeamQuiescedError,
} from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamBackupWorkSyncRestoreCoordinator } from '@main/services/team/TeamBackupWorkSyncRestoreCoordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
  backupsBase: '',
  appDataPath: '',
  tasksBase: '',
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
  getBackupsBasePath: () => hoisted.backupsBase,
  getAppDataPath: () => hoisted.appDataPath,
  getTasksBasePath: () => hoisted.tasksBase,
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function createCoordinator(gate: MemberWorkSyncTeamOperationGate) {
  const owner = new TeamBackupWorkSyncRestoreCoordinator({
    registry: () => ({}),
    getBackupDir: (team) => team,
    isShuttingDown: () => false,
    isReplacementForPendingDeletion: () => false,
    isPermanentDeletionFenced: async () => false,
    withIdentityFence: async (_team, operation) => operation(),
    withTeamMutex: async (_team, operation) => operation(),
    restoreLegacy: async () => false,
    restoreGeneric: async () => false,
  });
  owner.configure(gate, {
    prepare: async () => ({ importAndVerify: async () => undefined }),
  });
  return owner;
}

describe('TeamBackupWorkSyncRestoreCoordinator.runWhileQuiesced', () => {
  it('waits for in-flight work-sync before snapshot and rejects new admissions until release', async () => {
    const gate = new MemberWorkSyncTeamOperationGate();
    const owner = createCoordinator(gate);
    const hold = deferred();
    const entered = deferred();
    const inflight = gate.run('team-a', async () => {
      entered.resolve();
      await hold.promise;
    });
    await entered.promise;

    let snapshotStarted = false;
    const snapshot = owner.runWhileQuiesced('team-a', async () => {
      snapshotStarted = true;
      await expect(gate.run('team-a', async () => 'no')).rejects.toThrow(
        MemberWorkSyncTeamQuiescedError
      );
      return 'copied';
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshotStarted).toBe(false);

    hold.resolve();
    await inflight;
    await expect(snapshot).resolves.toBe('copied');
    expect(snapshotStarted).toBe(true);
    await expect(gate.run('team-a', async () => 'open')).resolves.toBe('open');
  });

  it('copies without quiesce when work-sync restore is not configured', async () => {
    const owner = new TeamBackupWorkSyncRestoreCoordinator({
      registry: () => ({}),
      getBackupDir: (team) => team,
      isShuttingDown: () => false,
      isReplacementForPendingDeletion: () => false,
      isPermanentDeletionFenced: async () => false,
      withIdentityFence: async (_team, operation) => operation(),
      withTeamMutex: async (_team, operation) => operation(),
      restoreLegacy: async () => false,
      restoreGeneric: async () => false,
    });
    await expect(owner.runWhileQuiesced('team-a', async () => 'copied')).resolves.toBe('copied');
  });
});

describe('TeamBackupService periodic work-sync quiesce', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-work-sync-quiesce-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    hoisted.backupsBase = path.join(tempDir, 'backups');
    hoisted.appDataPath = path.join(tempDir, 'app-data');
    hoisted.tasksBase = path.join(tempDir, 'tasks');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
    await fs.mkdir(hoisted.backupsBase, { recursive: true });
    await fs.mkdir(hoisted.appDataPath, { recursive: true });
    await fs.mkdir(hoisted.tasksBase, { recursive: true });
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    hoisted.backupsBase = '';
    hoisted.appDataPath = '';
    hoisted.tasksBase = '';
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('quiesces work-sync before a periodic backup copy', async () => {
    const teamName = 'sandbox-quiesce-periodic';
    const seed = new TeamBackupService();
    try {
      await seed.initialize();
      await fs.mkdir(path.join(hoisted.teamsBase, teamName), { recursive: true });
      await fs.writeFile(
        path.join(hoisted.teamsBase, teamName, 'config.json'),
        JSON.stringify({ name: teamName, members: [] })
      );
      await seed.backupTeam(teamName);
    } finally {
      seed.dispose();
    }

    const gate = new MemberWorkSyncTeamOperationGate();
    const owner = new TeamBackupService();
    owner.configureWorkSyncRestore(gate, {
      prepare: async () => ({ importAndVerify: async () => undefined }),
    });
    const ports = owner as unknown as {
      runPeriodicBackup(): Promise<void>;
      doBackupTeam(name: string): Promise<void>;
    };
    const actualBackup = ports.doBackupTeam.bind(ports);
    const snapshotHold = deferred();
    const snapshotEntered = deferred();
    const quiesceEntered = deferred();
    const backupSpy = vi.spyOn(ports, 'doBackupTeam').mockImplementation(async (name) => {
      snapshotEntered.resolve();
      await snapshotHold.promise;
      return actualBackup(name);
    });
    const restore = (
      owner as unknown as { workSyncRestore: TeamBackupWorkSyncRestoreCoordinator }
    ).workSyncRestore;
    const actualQuiesce = restore.runWhileQuiesced.bind(restore);
    const quiesceSpy = vi
      .spyOn(restore, 'runWhileQuiesced')
      .mockImplementation(async (teamName, operation) => {
        quiesceEntered.resolve();
        return actualQuiesce(teamName, operation);
      });
    const hold = deferred();
    try {
      await owner.initialize();
      const entered = deferred();
      const inflight = gate.run(teamName, async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;

      const periodic = ports.runPeriodicBackup();
      await quiesceEntered.promise;
      expect(backupSpy).not.toHaveBeenCalled();
      hold.resolve();
      await inflight;
      await snapshotEntered.promise;
      await expect(gate.run(teamName, async () => 'no')).rejects.toThrow(
        MemberWorkSyncTeamQuiescedError
      );
      snapshotHold.resolve();
      await periodic;
      await expect(gate.run(teamName, async () => 'open')).resolves.toBe('open');
    } finally {
      hold.resolve();
      snapshotHold.resolve();
      quiesceSpy.mockRestore();
      backupSpy.mockRestore();
      owner.dispose();
    }
  });
});
