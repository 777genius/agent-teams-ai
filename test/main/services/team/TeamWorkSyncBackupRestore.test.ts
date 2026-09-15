import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/main';
import { restoreTeamWorkSyncBackup } from '@main/services/team/TeamWorkSyncBackupRestore';
import { TeamWorkSyncRestoreAttemptOwner } from '@main/services/team/TeamWorkSyncRestoreAttemptOwner';
import { TeamWorkSyncRestorePending } from '@main/services/team/TeamWorkSyncRestorePending';
import { expect, it } from 'vitest';

it('retains durable pending and admission after failed import, then completes retry in order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-flow-'));
  const manifestPath = path.join(root, 'manifest.json');
  const gate = new MemberWorkSyncTeamOperationGate();
  let fence = false;
  let mutex = false;
  let failImport = true;
  const order: string[] = [];
  const attempts = new TeamWorkSyncRestoreAttemptOwner({
    operationGate: gate,
    withIdentityFence: async (_team, operation) => {
      fence = true;
      try {
        await operation();
      } finally {
        fence = false;
      }
    },
  });
  const pending = new TeamWorkSyncRestorePending({
    getManifestPath: () => manifestPath,
    isShuttingDown: () => false,
  });
  const ports = {
    attempts,
    pending,
    withTeamMutex: async (_team: string, operation: () => Promise<void>) => {
      expect(fence).toBe(true);
      mutex = true;
      try {
        await operation();
      } finally {
        mutex = false;
      }
    },
    prepare: async () => {
      expect(fence && mutex).toBe(true);
      order.push('prepare');
      return {
        identityId: 'id',
        restoreGeneric: async () => {
          expect(
            JSON.parse(await fs.readFile(manifestPath, 'utf8')).workSyncRestorePending
          ).toBeDefined();
          order.push('generic');
        },
        importAndVerify: async () => {
          order.push('import');
          if (failImport) throw new Error('import failed');
        },
        invalidate: async () => {
          order.push('invalidate');
        },
      };
    },
  };
  try {
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        teamName: 'sandbox',
        identityId: 'id',
        status: 'active',
        firstBackupAt: 'now',
        lastBackupAt: 'now',
        fileStats: {},
      })
    );
    await expect(restoreTeamWorkSyncBackup(ports, 'sandbox')).rejects.toThrow('import failed');
    const generation = JSON.parse(await fs.readFile(manifestPath, 'utf8')).workSyncRestorePending;
    await expect(gate.run('sandbox', async () => undefined)).rejects.toThrow();
    expect(await pending.begin('sandbox', 'id')).toEqual(generation);
    failImport = false;
    await restoreTeamWorkSyncBackup(ports, 'sandbox');
    expect(order).toEqual([
      'prepare',
      'generic',
      'import',
      'prepare',
      'generic',
      'import',
      'invalidate',
    ]);
    expect(
      JSON.parse(await fs.readFile(manifestPath, 'utf8')).workSyncRestorePending
    ).toBeUndefined();
    await expect(gate.run('sandbox', async () => 'open')).resolves.toBe('open');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


it('holds both owner locks until an interrupted import physically retires', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-tail-'));
  const manifestPath = path.join(root, 'manifest.json');
  let release!: () => void;
  const physical = new Promise<void>((resolve) => { release = resolve; });
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  let fence = false;
  let mutex = false;
  const gate = new MemberWorkSyncTeamOperationGate();
  const attempts = new TeamWorkSyncRestoreAttemptOwner({operationGate: gate, withIdentityFence: async (_team, operation) => {
    fence = true;
    try { await operation(); } finally { fence = false; }
  }});
  const pending = new TeamWorkSyncRestorePending({getManifestPath: () => manifestPath, isShuttingDown: () => false});
  await fs.writeFile(manifestPath, JSON.stringify({teamName: 'sandbox', identityId: 'id', status: 'active', firstBackupAt: 'now', lastBackupAt: 'now', fileStats: {}}));
  const failure = new InternalStorageOperationInterruptedError('unknown', 'unknown', physical);
  let invalidateCount = 0;
  const operation = restoreTeamWorkSyncBackup({attempts, pending,
    withTeamMutex: async (_team, callback) => {
      mutex = true;
      try { await callback(); } finally { mutex = false; }
    }, prepare: async () => ({identityId: 'id', restoreGeneric: async () => undefined,
      importAndVerify: async () => { signal(); throw failure; },
      invalidate: async () => { invalidateCount++; },
    }),
  }, 'sandbox');
  const outcome = operation.catch((error: unknown) => error);
  try {
    await reached;
    await Promise.resolve();
    expect(fence && mutex).toBe(true);
    expect(invalidateCount).toBe(0);
    await expect(gate.run('sandbox', async () => undefined)).rejects.toThrow();
    release();
    expect(await outcome).toBe(failure);
    expect(fence || mutex).toBe(false);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).workSyncRestorePending).toBeDefined();
  } finally { release(); await outcome; await fs.rm(root, {recursive: true, force: true}); }
});
