import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InternalStorageJsonReplica } from '@features/internal-storage/main';
import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/main';
import { createMemberWorkSyncRestoreParticipant } from '@features/member-work-sync/main/composition/createMemberWorkSyncRestoreParticipant';
import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import {
  isMemberWorkSyncStoreSnapshot,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { TeamBackupWorkSyncRestoreCoordinator } from '@main/services/team/TeamBackupWorkSyncRestoreCoordinator';
import { expect, it, vi } from 'vitest';

import { createTestWorkSyncIdentity } from '../../../features/member-work-sync/helpers/createTestWorkSyncIdentity';

const env = vi.hoisted(() => ({ teams: '' }));
vi.mock('@main/utils/pathDecoder', () => ({ getTeamsBasePath: () => env.teams }));

it.each(['resolve', 'reject'] as const)(
  'continues B while interrupted A retains its physical locks until %s',
  async (settlement) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-startup-isolation-'));
    env.teams = path.join(root, 'teams');
    const backups = path.join(root, 'backups');
    const gate = new MemberWorkSyncTeamOperationGate();
    const fences = new Set<string>();
    const mutexes = new Set<string>();
    let resolveTail!: () => void;
    let rejectTail!: (error: Error) => void;
    const tail = new Promise<void>((resolve, reject) => {
      resolveTail = resolve;
      rejectTail = reject;
    });
    const failure = new InternalStorageOperationInterruptedError('unknown', 'unknown', tail);
    const registry = Object.fromEntries(
      ['a', 'b'].map((team) => [team, { identityId: team, status: 'active' as const }])
    );
    for (const team of ['a', 'b']) {
      await fs.mkdir(path.join(backups, team), { recursive: true });
      await fs.writeFile(
        path.join(backups, team, 'manifest.json'),
        JSON.stringify({
          teamName: team,
          identityId: team,
          status: 'active',
          firstBackupAt: 'now',
          lastBackupAt: 'now',
          fileStats: {},
        })
      );
      await fs.writeFile(
        path.join(backups, team, 'config.json'),
        JSON.stringify({ name: team, members: [], _backupIdentityId: team })
      );
    }
    const owner = new TeamBackupWorkSyncRestoreCoordinator({
      registry: () => registry,
      getBackupDir: (team) => path.join(backups, team),
      isShuttingDown: () => false,
      isReplacementForPendingDeletion: () => false,
      isPermanentDeletionFenced: async () => false,
      withIdentityFence: async (team, operation) => {
        expect(fences.has(team)).toBe(false);
        fences.add(team);
        try {
          return await operation();
        } finally {
          fences.delete(team);
        }
      },
      withTeamMutex: async (team, operation) => {
        expect(mutexes.has(team)).toBe(false);
        mutexes.add(team);
        try {
          await operation();
        } finally {
          mutexes.delete(team);
        }
      },
      restoreLegacy: async () => {
        throw new Error('legacy must not run');
      },
      restoreGeneric: async (team) => {
        await fs.mkdir(path.join(env.teams, team), { recursive: true });
        await fs.copyFile(
          path.join(backups, team, 'config.json'),
          path.join(env.teams, team, 'config.json')
        );
        return true;
      },
    });
    const imports: string[] = [];
    owner.configure(gate, {
      prepare: async ({ teamName }) => ({
        importAndVerify: async () => {
          imports.push(teamName);
          if (teamName === 'a') throw failure;
        },
      }),
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let retry: Promise<string[]> | undefined;
    try {
      expect(await owner.restoreIfNeeded()).toEqual(['b']);
      expect(fences.has('a') && mutexes.has('a')).toBe(true);
      await expect(gate.run('a', async () => undefined)).rejects.toThrow();
      await expect(gate.run('b', async () => 'open')).resolves.toBe('open');
      const pending = await fs.readFile(path.join(backups, 'a', 'manifest.json'), 'utf8');
      expect(JSON.parse(pending).workSyncRestorePending).toBeDefined();
      let retryFinished = false;
      retry = owner.restoreIfNeeded().then((result) => {
        retryFinished = true;
        return result;
      });
      await Promise.resolve();
      expect(retryFinished).toBe(false);
      expect(imports).toEqual(['a', 'b']);
      if (settlement === 'resolve') resolveTail();
      else rejectTail(new Error('late physical failure'));
      await retry;
      expect(fences.has('a') || mutexes.has('a')).toBe(false);
      expect(await fs.readFile(path.join(backups, 'a', 'manifest.json'), 'utf8')).toBe(pending);
      await expect(gate.run('a', async () => undefined)).rejects.toThrow();
    } finally {
      resolveTail();
      await retry;
      warning.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it('rejects dirty JSON backup before the production coordinator publishes config or pending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-preflight-owner-'));
  env.teams = path.join(root, 'teams');
  const backupRoot = path.join(root, 'backups');
  const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
  const livePaths = new MemberWorkSyncStorePaths(env.teams);
  const team = 'sandbox';
  const backupDir = path.join(backupRoot, team);
  await fs.mkdir(backupDir, { recursive: true });
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = JSON.stringify({
    teamName: team,
    identityId: 'id',
    status: 'active',
    firstBackupAt: 'now',
    lastBackupAt: 'now',
    fileStats: {},
  });
  await fs.writeFile(manifestPath, manifest);
  await fs.writeFile(
    path.join(backupDir, 'config.json'),
    JSON.stringify({ name: team, members: [], _backupIdentityId: 'id' })
  );
  const replica = new InternalStorageJsonReplica(
    (name) => backupPaths.getSqliteFallbackReplicaPath(name),
    isMemberWorkSyncStoreSnapshot
  );
  await replica.markDirtyWithRecoveryCandidate(team, 'id', {
    statuses: [],
    reportIntents: [],
    outboxItems: [],
    metricEvents: [],
    filesToArchive: [],
  });
  const generic = vi.fn(async () => true);
  const gate = new MemberWorkSyncTeamOperationGate();
  const owner = new TeamBackupWorkSyncRestoreCoordinator({
    registry: () => ({ [team]: { identityId: 'id', status: 'active' } }),
    getBackupDir: () => backupDir,
    isShuttingDown: () => false,
    isReplacementForPendingDeletion: () => false,
    isPermanentDeletionFenced: async () => false,
    withIdentityFence: async (_name, operation) => operation(),
    withTeamMutex: async (_name, operation) => operation(),
    restoreLegacy: generic,
    restoreGeneric: generic,
  });
  owner.configure(
    gate,
    createMemberWorkSyncRestoreParticipant(
      new JsonMemberWorkSyncStore(livePaths),
      new HmacMemberWorkSyncReportTokenAdapter(livePaths, createTestWorkSyncIdentity('id')),
      livePaths
    )
  );
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(await owner.restoreIfNeeded()).toEqual([]);
    expect(generic).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(env.teams, team, 'config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(manifest);
    await expect(gate.run(team, async () => undefined)).rejects.toThrow();
  } finally {
    warning.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
