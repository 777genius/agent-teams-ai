import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as nativeFs from 'node:fs';

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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

import { TeamBackupService } from '../../../../src/main/services/team/TeamBackupService';
import type {
  PermanentDeletionTarget,
  TeamPermanentDeletionIntent,
} from '../../../../src/main/services/team/TeamBackupService';
import { removePathWithIdentityFenceAsync } from '../../../../src/main/utils/atomicWrite';

async function removePreparedDeletionTargets(
  service: TeamBackupService,
  intent: TeamPermanentDeletionIntent
): Promise<void> {
  await service.withPermanentDeletionTargetFence(
    intent,
    async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
      const targetPaths: Record<PermanentDeletionTarget, string> = {
        'team-data': path.join(hoisted.teamsBase, intent.teamName),
        'task-data': path.join(hoisted.tasksBase, intent.teamName),
        'message-attachments': path.join(hoisted.appDataPath, 'attachments', intent.teamName),
        'task-attachments': path.join(hoisted.appDataPath, 'task-attachments', intent.teamName),
      };
      for (const target of Object.keys(targetPaths) as PermanentDeletionTarget[]) {
        if (isTargetCompleted(target)) continue;
        const removal = await removePathWithIdentityFenceAsync(targetPaths[target], {
          recursive: true,
          force: true,
          durability: 'strict',
          validateDetached: (detachedPath) => isTargetCurrent(target, detachedPath),
          proofHooks: getTargetProofHooks(target),
        });
        if (removal !== 'deleted') return false;
      }
      return true;
    }
  );
}

function getPermanentDeletionLockPath(backupsBase: string, scope: string): string {
  const lockKey = crypto
    .createHash('sha256')
    .update(`${path.resolve(backupsBase)}\0${scope}`)
    .digest('hex');
  return path.join(os.tmpdir(), `.agent-teams-permanent-deletion-${lockKey}.lock`);
}

interface PermanentDeletionTestLock {
  lockPath: string;
  owner: {
    version: 2;
    token: string;
    pid: number;
    processInstanceId: string;
    createdAt: string;
    targetPath: string;
  };
  identity: { dev: number; ino: number; birthtimeMs: number };
  ownerEntryName: string;
}

function getAcquirePermanentDeletionLock(
  service: TeamBackupService
): (lockScope: string) => Promise<PermanentDeletionTestLock> {
  return (
    service as unknown as {
      acquirePermanentDeletionLock(lockScope: string): Promise<PermanentDeletionTestLock>;
    }
  ).acquirePermanentDeletionLock.bind(service);
}

function getReleasePermanentDeletionLock(
  service: TeamBackupService
): (lock: PermanentDeletionTestLock) => Promise<void> {
  return (
    service as unknown as {
      releasePermanentDeletionLock(lock: PermanentDeletionTestLock): Promise<void>;
    }
  ).releasePermanentDeletionLock.bind(service);
}

describe('TeamBackupService', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-backup-service-'));
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
    vi.useRealTimers();
    hoisted.teamsBase = '';
    hoisted.backupsBase = '';
    hoisted.appDataPath = '';
    hoisted.tasksBase = '';
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('backs up and restores additive mixed-lane metadata and launch snapshots', async () => {
    const service = new TeamBackupService();
    const teamName = 'mixed-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(teamDir, { recursive: true });

    const config = {
      name: 'Mixed Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    };
    const teamMeta = {
      version: 1,
      cwd: projectPath,
      providerId: 'codex',
      providerBackendId: 'codex-native',
      fastMode: 'off',
      createdAt: Date.now(),
    };
    const membersMeta = {
      version: 1,
      providerBackendId: 'codex-native',
      members: [
        { name: 'alice', providerId: 'codex', role: 'reviewer' },
        {
          name: 'tom',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'minimax-m2.5-free',
          fastMode: 'inherit',
          role: 'developer',
        },
      ],
    };
    const launchState = {
      version: 2,
      teamName,
      updatedAt: '2026-04-22T12:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice', 'tom'],
      bootstrapExpectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
        tom: {
          name: 'tom',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
      },
      summary: {
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_pending',
    };
    const launchSummary = {
      version: 1,
      teamName,
      updatedAt: '2026-04-22T12:00:00.000Z',
      mixedAware: true,
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      pendingCount: 1,
      failedCount: 0,
      teamLaunchState: 'partial_pending',
      launchUpdatedAt: '2026-04-22T12:00:00.000Z',
    };
    const runtimeLaneDir = path.join(
      teamDir,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent('secondary:opencode:tom')
    );
    const runtimeLaneIndex = {
      version: 1,
      updatedAt: '2026-04-22T12:00:00.000Z',
      lanes: {
        'secondary:opencode:tom': {
          laneId: 'secondary:opencode:tom',
          state: 'active',
          updatedAt: '2026-04-22T12:00:00.000Z',
          diagnostics: [],
        },
      },
    };
    const runtimeManifest = {
      schemaVersion: 1,
      highWatermark: 12,
      activeRunId: 'lane-run-1',
      capabilitySnapshotId: 'cap-1',
    };

    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config), 'utf8');
    await fs.writeFile(path.join(teamDir, 'team.meta.json'), JSON.stringify(teamMeta), 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify(membersMeta),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify(launchState),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify(launchSummary),
      'utf8'
    );
    await fs.mkdir(runtimeLaneDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, '.opencode-runtime', 'lanes.json'),
      JSON.stringify(runtimeLaneIndex),
      'utf8'
    );
    await fs.writeFile(
      path.join(runtimeLaneDir, 'runtime-store-manifest.json'),
      JSON.stringify(runtimeManifest),
      'utf8'
    );

    await service.initialize();
    await service.backupTeam(teamName);

    await fs.rm(teamDir, { recursive: true, force: true });

    const restored = await service.restoreIfNeeded();
    service.dispose();

    expect(restored).toContain(teamName);

    const restoredMembersMeta = JSON.parse(
      await fs.readFile(path.join(teamDir, 'members.meta.json'), 'utf8')
    );
    const restoredLaunchState = JSON.parse(
      await fs.readFile(path.join(teamDir, 'launch-state.json'), 'utf8')
    );
    const restoredLaunchSummary = JSON.parse(
      await fs.readFile(path.join(teamDir, 'launch-summary.json'), 'utf8')
    );
    const restoredTeamMeta = JSON.parse(
      await fs.readFile(path.join(teamDir, 'team.meta.json'), 'utf8')
    );
    const restoredRuntimeLaneIndex = JSON.parse(
      await fs.readFile(path.join(teamDir, '.opencode-runtime', 'lanes.json'), 'utf8')
    );
    const restoredRuntimeManifest = JSON.parse(
      await fs.readFile(path.join(runtimeLaneDir, 'runtime-store-manifest.json'), 'utf8')
    );

    expect(restoredTeamMeta.providerId).toBe('codex');
    expect(restoredMembersMeta.members).toEqual(membersMeta.members);
    expect(restoredLaunchState.bootstrapExpectedMembers).toEqual(['alice']);
    expect(restoredLaunchState.members.tom.laneKind).toBe('secondary');
    expect(restoredLaunchState.members.tom.laneOwnerProviderId).toBe('opencode');
    expect(restoredLaunchSummary.mixedAware).toBe(true);
    expect(restoredLaunchSummary.teamLaunchState).toBe('partial_pending');
    expect(restoredRuntimeLaneIndex.lanes['secondary:opencode:tom'].state).toBe('active');
    expect(restoredRuntimeManifest.activeRunId).toBe('lane-run-1');
  });

  it('fences startup restore after the durable destructive deletion boundary', async () => {
    const teamName = 'delete-crash-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const firstService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Delete Crash Team' }), 'utf8');

    await firstService.initialize();
    await firstService.backupTeam(teamName);
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
    await fs.rm(teamDir, { recursive: true, force: true });
    firstService.dispose();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();
    const pending = await recoveredService.listPendingPermanentDeletions();

    expect(deleting.phase).toBe('deleting');
    expect(pending).toEqual([
      expect.objectContaining({
        teamName,
        identityId: deleting.identityId,
        phase: 'deleting',
      }),
    ]);
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    recoveredService.dispose();
  });

  it('rolls back a crash before the destructive boundary and keeps the source team', async () => {
    const teamName = 'prepared-delete-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const intentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    const firstService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Prepared Delete Team' }), 'utf8');

    await firstService.initialize();
    await firstService.beginPermanentDeletion(teamName);
    firstService.dispose();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();

    await expect(fs.stat(configPath)).resolves.toBeDefined();
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(recoveredService.listPendingPermanentDeletions()).resolves.toEqual([]);
    recoveredService.dispose();
  });

  it('does not let stale transaction ownership commit, abort, or recover a newer intent', async () => {
    const teamName = 'exact-transaction-owner-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const intentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    const staleService = new TeamBackupService();
    const currentService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Exact Transaction Owner Team',
        _backupIdentityId: 'shared-durable-team-identity',
      }),
      'utf8'
    );
    await staleService.initialize();
    await currentService.initialize();

    const staleIntent = await staleService.beginPermanentDeletion(teamName);
    await currentService.abortPreparedPermanentDeletion(staleIntent);
    const currentIntent = await currentService.beginPermanentDeletion(teamName);

    expect(currentIntent.identityId).toBe(staleIntent.identityId);
    expect(currentIntent.transactionId).not.toBe(staleIntent.transactionId);
    await expect(staleService.isPermanentDeletionTargetCurrent(staleIntent)).rejects.toThrow(
      `Permanent deletion intent changed for ${teamName}`
    );
    await expect(staleService.commitPermanentDeletionBoundary(staleIntent)).rejects.toThrow(
      `Permanent deletion intent changed for ${teamName}`
    );
    await expect(staleService.abortPreparedPermanentDeletion(staleIntent)).resolves.toBeUndefined();

    const persistedPrepared = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      transactionId: string;
      phase: string;
    };
    expect(persistedPrepared).toMatchObject({
      transactionId: currentIntent.transactionId,
      phase: 'prepared',
    });

    const deletingIntent = await currentService.commitPermanentDeletionBoundary(currentIntent);
    const recoveryOperation = vi.fn(() => Promise.resolve(true));
    await expect(staleService.reconcilePermanentDeletionProgress(staleIntent)).rejects.toThrow(
      `Permanent deletion intent changed for ${teamName}`
    );
    await expect(
      staleService.withPermanentDeletionTargetFence(staleIntent, recoveryOperation)
    ).rejects.toThrow(`Permanent deletion intent changed for ${teamName}`);
    await expect(staleService.completePermanentDeletion(staleIntent)).rejects.toThrow(
      `Permanent deletion intent changed for ${teamName}`
    );
    expect(recoveryOperation).not.toHaveBeenCalled();

    const persistedDeleting = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      transactionId: string;
      phase: string;
    };
    expect(deletingIntent).toMatchObject({
      transactionId: currentIntent.transactionId,
      phase: 'deleting',
    });
    expect(persistedDeleting).toMatchObject({
      transactionId: currentIntent.transactionId,
      phase: 'deleting',
    });
    staleService.dispose();
    currentService.dispose();
  });

  it('persists the deletion-intent directory entry before publishing the first intent', async () => {
    const teamName = 'intent-directory-sync-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const intentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    const service = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'Intent Directory Sync Team' }),
      'utf8'
    );
    await service.initialize();
    await fs.rm(hoisted.backupsBase, { recursive: true, force: true });

    let signalParentSyncStarted!: () => void;
    let releaseParentSync!: () => void;
    const parentSyncStarted = new Promise<void>((resolve) => {
      signalParentSyncStarted = resolve;
    });
    const parentSyncRelease = new Promise<void>((resolve) => {
      releaseParentSync = resolve;
    });
    const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
    const openSpy = vi.spyOn(nativeFs.promises, 'open').mockImplementation((filePath, flags) => {
      if (path.resolve(String(filePath)) === path.resolve(hoisted.backupsBase) && flags === 'r') {
        return Promise.resolve({
          sync: async () => {
            signalParentSyncStarted();
            await parentSyncRelease;
          },
          close: () => Promise.resolve(),
        } as unknown as nativeFs.promises.FileHandle);
      }
      return realOpen(filePath, flags);
    });

    const beginPromise = service.beginPermanentDeletion(teamName);
    try {
      await parentSyncStarted;
      await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: 'ENOENT' });

      releaseParentSync();
      await expect(beginPromise).resolves.toMatchObject({ teamName, phase: 'prepared' });
      await expect(fs.stat(intentPath)).resolves.toBeDefined();
      const directorySyncOpenPaths = openSpy.mock.calls
        .filter(([, flags]) => flags === 'r')
        .map(([filePath]) => path.resolve(String(filePath)));
      expect(directorySyncOpenPaths.indexOf(path.resolve(tempDir))).toBeGreaterThanOrEqual(0);
      expect(directorySyncOpenPaths.indexOf(path.resolve(tempDir))).toBeLessThan(
        directorySyncOpenPaths.indexOf(path.resolve(hoisted.backupsBase))
      );
    } finally {
      releaseParentSync();
      await beginPromise.catch(() => undefined);
      openSpy.mockRestore();
      service.dispose();
    }
  });

  it('serializes concurrent teams until every shared hierarchy entry is durable', async () => {
    const firstTeamName = 'first-hierarchy-team';
    const secondTeamName = 'second-hierarchy-team';
    const intentsDir = path.join(hoisted.backupsBase, 'permanent-deletion-intents');
    const firstIntentPath = path.join(intentsDir, `${encodeURIComponent(firstTeamName)}.json`);
    const secondIntentPath = path.join(intentsDir, `${encodeURIComponent(secondTeamName)}.json`);
    const service = new TeamBackupService();
    for (const [teamName, identityId] of [
      [firstTeamName, 'first-hierarchy-identity'],
      [secondTeamName, 'second-hierarchy-identity'],
    ]) {
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: teamName, _backupIdentityId: identityId }),
        'utf8'
      );
    }
    await service.initialize();
    await fs.rm(hoisted.backupsBase, { recursive: true, force: true });

    let signalAncestorSyncStarted!: () => void;
    let releaseAncestorSync!: () => void;
    const ancestorSyncStarted = new Promise<void>((resolve) => {
      signalAncestorSyncStarted = resolve;
    });
    const ancestorSyncRelease = new Promise<void>((resolve) => {
      releaseAncestorSync = resolve;
    });
    const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
    const openSpy = vi.spyOn(nativeFs.promises, 'open').mockImplementation((filePath, flags) => {
      if (path.resolve(String(filePath)) === path.resolve(tempDir) && flags === 'r') {
        return Promise.resolve({
          sync: async () => {
            signalAncestorSyncStarted();
            await ancestorSyncRelease;
          },
          close: () => Promise.resolve(),
        } as unknown as nativeFs.promises.FileHandle);
      }
      return realOpen(filePath, flags);
    });

    const firstBegin = service.beginPermanentDeletion(firstTeamName);
    let secondBegin: Promise<unknown> | null = null;
    const cleanupSpies: { mockRestore: () => void }[] = [];
    try {
      await ancestorSyncStarted;
      const hierarchyStatSpy = vi.spyOn(nativeFs.promises, 'stat');
      cleanupSpies.push(hierarchyStatSpy);

      let signalSecondConfigRead!: () => void;
      const secondConfigRead = new Promise<void>((resolve) => {
        signalSecondConfigRead = resolve;
      });
      const secondConfigPath = path.join(hoisted.teamsBase, secondTeamName, 'config.json');
      const realReadFile = nativeFs.promises.readFile.bind(nativeFs.promises);
      let sawSecondConfig = false;
      const readFileSpy = vi.spyOn(nativeFs.promises, 'readFile').mockImplementation(((
        file: unknown,
        ...args: unknown[]
      ) => {
        const read = realReadFile(file as never, ...(args as never[])) as Promise<unknown>;
        if (!sawSecondConfig && path.resolve(String(file)) === path.resolve(secondConfigPath)) {
          sawSecondConfig = true;
          return read.then((value) => {
            signalSecondConfigRead();
            return value;
          }) as never;
        }
        return read as never;
      }) as never);
      cleanupSpies.push(readFileSpy);

      secondBegin = service.beginPermanentDeletion(secondTeamName);
      await secondConfigRead;
      for (let index = 0; index < 8; index += 1) await Promise.resolve();

      const hierarchyStatsBeforeRelease = hierarchyStatSpy.mock.calls.filter(
        ([filePath]) => path.resolve(String(filePath)) === path.resolve(intentsDir)
      );
      expect(hierarchyStatsBeforeRelease).toHaveLength(0);
      await expect(fs.stat(firstIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(secondIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });

      releaseAncestorSync();
      await expect(firstBegin).resolves.toMatchObject({ teamName: firstTeamName });
      await expect(secondBegin).resolves.toMatchObject({ teamName: secondTeamName });
      await expect(fs.stat(firstIntentPath)).resolves.toBeDefined();
      await expect(fs.stat(secondIntentPath)).resolves.toBeDefined();
    } finally {
      releaseAncestorSync();
      await Promise.allSettled([firstBegin, ...(secondBegin ? [secondBegin] : [])]);
      for (const spy of cleanupSpies.toReversed()) spy.mockRestore();
      openSpy.mockRestore();
      service.dispose();
    }
  });

  it('serializes separately loaded writers before publishing a shared hierarchy intent', async () => {
    const firstTeamName = 'first-independent-writer';
    const secondTeamName = 'second-independent-writer';
    const intentsDir = path.join(hoisted.backupsBase, 'permanent-deletion-intents');
    const firstIntentPath = path.join(intentsDir, `${encodeURIComponent(firstTeamName)}.json`);
    const secondIntentPath = path.join(intentsDir, `${encodeURIComponent(secondTeamName)}.json`);
    for (const [teamName, identityId] of [
      [firstTeamName, 'first-independent-identity'],
      [secondTeamName, 'second-independent-identity'],
    ]) {
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: teamName, _backupIdentityId: identityId }),
        'utf8'
      );
    }

    const firstService = new TeamBackupService();
    await firstService.initialize();
    vi.resetModules();
    const independentlyLoaded =
      await import('../../../../src/main/services/team/TeamBackupService');
    const secondService = new independentlyLoaded.TeamBackupService();
    await secondService.initialize();
    await fs.rm(hoisted.backupsBase, { recursive: true, force: true });

    let signalAncestorSyncStarted!: () => void;
    let releaseAncestorSync!: () => void;
    const ancestorSyncStarted = new Promise<void>((resolve) => {
      signalAncestorSyncStarted = resolve;
    });
    const ancestorSyncRelease = new Promise<void>((resolve) => {
      releaseAncestorSync = resolve;
    });
    let signalSecondLockAttempt!: () => void;
    const secondLockAttempt = new Promise<void>((resolve) => {
      signalSecondLockAttempt = resolve;
    });
    const globalLockPath = getPermanentDeletionLockPath(hoisted.backupsBase, 'intent-hierarchy');
    const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
    const openSpy = vi.spyOn(nativeFs.promises, 'open').mockImplementation((filePath, flags) => {
      if (path.resolve(String(filePath)) === path.resolve(tempDir) && flags === 'r') {
        return Promise.resolve({
          sync: async () => {
            signalAncestorSyncStarted();
            await ancestorSyncRelease;
          },
          close: () => Promise.resolve(),
        } as unknown as nativeFs.promises.FileHandle);
      }
      return realOpen(filePath, flags);
    });
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    let globalLockPublishAttempts = 0;
    const renameSpy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation((source, target) => {
      if (path.resolve(String(target)) === path.resolve(globalLockPath)) {
        globalLockPublishAttempts += 1;
        if (globalLockPublishAttempts === 2) signalSecondLockAttempt();
      }
      return realRename(source, target);
    });

    const firstBegin = firstService.beginPermanentDeletion(firstTeamName);
    let secondBegin: Promise<unknown> | null = null;
    try {
      await ancestorSyncStarted;
      secondBegin = secondService.beginPermanentDeletion(secondTeamName);
      await secondLockAttempt;

      await expect(fs.stat(firstIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(secondIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });

      releaseAncestorSync();
      await expect(firstBegin).resolves.toMatchObject({ teamName: firstTeamName });
      await expect(secondBegin).resolves.toMatchObject({ teamName: secondTeamName });
      await expect(fs.stat(firstIntentPath)).resolves.toBeDefined();
      await expect(fs.stat(secondIntentPath)).resolves.toBeDefined();
    } finally {
      releaseAncestorSync();
      await Promise.allSettled([firstBegin, ...(secondBegin ? [secondBegin] : [])]);
      renameSpy.mockRestore();
      openSpy.mockRestore();
      firstService.dispose();
      secondService.dispose();
    }
  });

  it('recovers a crashed hierarchy lock owner and releases the replacement lock', async () => {
    const teamName = 'stale-lock-owner-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Stale Lock Owner Team',
        _backupIdentityId: 'stale-lock-owner-identity',
      }),
      'utf8'
    );
    const service = new TeamBackupService();
    await service.initialize();
    const lockPath = getPermanentDeletionLockPath(hoisted.backupsBase, 'intent-hierarchy');
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: 'crashed-owner-token',
        pid: 2_147_483_647,
        targetPath: path.resolve(hoisted.backupsBase),
      })}\n`,
      'utf8'
    );

    try {
      await expect(service.beginPermanentDeletion(teamName)).resolves.toMatchObject({
        teamName,
        phase: 'prepared',
      });
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(lockPath, { force: true });
      service.dispose();
    }
  });

  it('does not let a stale releaser displace a recovered owner or admit a third contender', async () => {
    const service = new TeamBackupService();
    const scope = 'exact-release-ownership';
    const acquireLock = (
      service as unknown as {
        acquirePermanentDeletionLock(lockScope: string): Promise<{
          lockPath: string;
          owner: {
            version: 2;
            token: string;
            pid: number;
            processInstanceId: string;
            createdAt: string;
            targetPath: string;
          };
          identity: { dev: number; ino: number; birthtimeMs: number };
        }>;
      }
    ).acquirePermanentDeletionLock.bind(service);
    const releaseLock = (
      service as unknown as {
        releasePermanentDeletionLock(lock: Awaited<ReturnType<typeof acquireLock>>): Promise<void>;
      }
    ).releasePermanentDeletionLock.bind(service);
    const staleLock = await acquireLock(scope);
    const staleOwnerPath = `${staleLock.lockPath}.superseded.${staleLock.owner.token}`;
    await fs.rename(staleLock.lockPath, staleOwnerPath);

    const recoveredOwner = {
      version: 2 as const,
      token: 'live-recovered-owner',
      pid: process.pid,
      processInstanceId: 'live-recovered-process',
      createdAt: new Date().toISOString(),
      targetPath: path.resolve(hoisted.backupsBase),
    };
    await fs.writeFile(staleLock.lockPath, `${JSON.stringify(recoveredOwner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const recoveredStats = await fs.lstat(staleLock.lockPath);

    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    let staleReleaseMovedCanonical = false;
    let thirdContenderAcquired = false;
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        if (
          path.resolve(String(sourcePath)) === path.resolve(staleLock.lockPath) &&
          String(destinationPath).includes(`.release.${staleLock.owner.token}`)
        ) {
          staleReleaseMovedCanonical = true;
          await realRename(sourcePath, destinationPath);
          try {
            await fs.writeFile(
              staleLock.lockPath,
              `${JSON.stringify({ ...recoveredOwner, token: 'third-contender' })}\n`,
              { encoding: 'utf8', flag: 'wx' }
            );
            thirdContenderAcquired = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          return;
        }
        await realRename(sourcePath, destinationPath);
      });

    try {
      await releaseLock(staleLock);

      const canonicalOwner = JSON.parse(
        await fs.readFile(staleLock.lockPath, 'utf8')
      ) as typeof recoveredOwner;
      const canonicalStats = await fs.lstat(staleLock.lockPath);
      expect(staleReleaseMovedCanonical).toBe(false);
      expect(thirdContenderAcquired).toBe(false);
      expect(canonicalOwner.token).toBe(recoveredOwner.token);
      expect(canonicalStats.dev).toBe(recoveredStats.dev);
      if (canonicalStats.ino !== 0 && recoveredStats.ino !== 0) {
        expect(canonicalStats.ino).toBe(recoveredStats.ino);
      }
    } finally {
      renameSpy.mockRestore();
      await fs.rm(staleLock.lockPath, { force: true });
      await fs.rm(staleOwnerPath, { recursive: true, force: true });
      service.dispose();
    }
  });

  it('keeps a replacement owner when it appears between release validation and detach', async () => {
    const ownerService = new TeamBackupService();
    const replacementService = new TeamBackupService();
    const thirdService = new TeamBackupService();
    const acquire = getAcquirePermanentDeletionLock;
    const release = getReleasePermanentDeletionLock;
    const scope = 'release-replacement-interleaving';
    const originalLock = await acquire(ownerService)(scope);
    let replacementLock: PermanentDeletionTestLock | null = null;
    let thirdLock: PermanentDeletionTestLock | null = null;
    let replacementInjected = false;
    let trackThirdAttempt = false;
    let signalThirdAttempt!: () => void;
    const thirdAttempt = new Promise<void>((resolve) => {
      signalThirdAttempt = resolve;
    });
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        const resolvedSource = path.resolve(String(sourcePath));
        const resolvedDestination = path.resolve(String(destinationPath));
        if (
          !replacementInjected &&
          resolvedSource === path.resolve(originalLock.lockPath, originalLock.ownerEntryName)
        ) {
          replacementInjected = true;
          await fs.rm(originalLock.lockPath, { recursive: true, force: true });
          replacementLock = await acquire(replacementService)(scope);
        } else if (
          trackThirdAttempt &&
          resolvedDestination === path.resolve(originalLock.lockPath)
        ) {
          trackThirdAttempt = false;
          signalThirdAttempt();
        }
        return realRename(sourcePath, destinationPath);
      });

    let thirdAcquire: Promise<PermanentDeletionTestLock> | null = null;
    try {
      await release(ownerService)(originalLock);
      expect(replacementInjected).toBe(true);
      expect(replacementLock).not.toBeNull();
      await expect(
        fs.readFile(path.join(originalLock.lockPath, replacementLock!.ownerEntryName), 'utf8')
      ).resolves.toContain(replacementLock!.owner.token);

      trackThirdAttempt = true;
      thirdAcquire = acquire(thirdService)(scope);
      await thirdAttempt;
      await expect(
        fs.readFile(path.join(originalLock.lockPath, replacementLock!.ownerEntryName), 'utf8')
      ).resolves.toContain(replacementLock!.owner.token);

      await release(replacementService)(replacementLock!);
      thirdLock = await thirdAcquire;
      await expect(
        fs.readFile(path.join(thirdLock.lockPath, thirdLock.ownerEntryName), 'utf8')
      ).resolves.toContain(thirdLock.owner.token);
    } finally {
      if (replacementLock)
        await release(replacementService)(replacementLock).catch(() => undefined);
      if (thirdAcquire && !thirdLock) {
        thirdLock = await thirdAcquire.catch(() => null);
      }
      if (thirdLock) await release(thirdService)(thirdLock).catch(() => undefined);
      renameSpy.mockRestore();
      await fs.rm(originalLock.lockPath, { recursive: true, force: true });
      ownerService.dispose();
      replacementService.dispose();
      thirdService.dispose();
    }
  });

  it('keeps a replacement owner when it appears between stale validation and detach', async () => {
    const staleService = new TeamBackupService();
    const replacementService = new TeamBackupService();
    const acquire = getAcquirePermanentDeletionLock;
    const release = getReleasePermanentDeletionLock;
    const removeStale = (
      staleService as unknown as {
        removeStalePermanentDeletionLock(lockPath: string): Promise<boolean>;
      }
    ).removeStalePermanentDeletionLock.bind(staleService);
    const scope = 'stale-replacement-interleaving';
    const staleLock = await acquire(staleService)(scope);
    const expired = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(staleLock.lockPath, staleLock.ownerEntryName), expired, expired);
    let replacementLock: PermanentDeletionTestLock | null = null;
    let replacementInjected = false;
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        if (
          !replacementInjected &&
          path.resolve(String(sourcePath)) ===
            path.resolve(staleLock.lockPath, staleLock.ownerEntryName)
        ) {
          replacementInjected = true;
          await fs.rm(staleLock.lockPath, { recursive: true, force: true });
          replacementLock = await acquire(replacementService)(scope);
        }
        return realRename(sourcePath, destinationPath);
      });

    try {
      await expect(removeStale(staleLock.lockPath)).resolves.toBe(false);
      expect(replacementInjected).toBe(true);
      expect(replacementLock).not.toBeNull();
      await expect(
        fs.readFile(path.join(staleLock.lockPath, replacementLock!.ownerEntryName), 'utf8')
      ).resolves.toContain(replacementLock!.owner.token);
    } finally {
      if (replacementLock)
        await release(replacementService)(replacementLock).catch(() => undefined);
      renameSpy.mockRestore();
      await fs.rm(staleLock.lockPath, { recursive: true, force: true });
      staleService.dispose();
      replacementService.dispose();
    }
  });

  it('does not remove another intent while a writer holds the durable hierarchy lock', async () => {
    const retainedTeamName = 'retained-intent-team';
    const writingTeamName = 'writing-intent-team';
    for (const [teamName, identityId] of [
      [retainedTeamName, 'retained-intent-identity'],
      [writingTeamName, 'writing-intent-identity'],
    ]) {
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: teamName, _backupIdentityId: identityId }),
        'utf8'
      );
    }
    const service = new TeamBackupService();
    await service.initialize();
    const retainedIntent = await service.beginPermanentDeletion(retainedTeamName);
    const retainedIntentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(retainedTeamName)}.json`
    );
    const writingIntentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(writingTeamName)}.json`
    );

    let signalWriteCommitStarted!: () => void;
    let releaseWriteCommit!: () => void;
    const writeCommitStarted = new Promise<void>((resolve) => {
      signalWriteCommitStarted = resolve;
    });
    const writeCommitRelease = new Promise<void>((resolve) => {
      releaseWriteCommit = resolve;
    });
    let signalAbortLockAttempt!: () => void;
    const abortLockAttempt = new Promise<void>((resolve) => {
      signalAbortLockAttempt = resolve;
    });
    const globalLockPath = getPermanentDeletionLockPath(hoisted.backupsBase, 'intent-hierarchy');
    let lockAttempts = 0;
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (source, target) => {
        if (path.resolve(String(target)) === path.resolve(globalLockPath)) {
          lockAttempts += 1;
          if (lockAttempts === 2) signalAbortLockAttempt();
        }
        if (path.resolve(String(target)) === path.resolve(writingIntentPath)) {
          signalWriteCommitStarted();
          await writeCommitRelease;
        }
        return realRename(source, target);
      });

    const writingBegin = service.beginPermanentDeletion(writingTeamName);
    let abortPromise: Promise<void> | null = null;
    try {
      await writeCommitStarted;
      abortPromise = service.abortPreparedPermanentDeletion(retainedIntent);
      await abortLockAttempt;
      await expect(fs.stat(retainedIntentPath)).resolves.toBeDefined();

      releaseWriteCommit();
      await writingBegin;
      await abortPromise;
      await expect(fs.stat(retainedIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseWriteCommit();
      await Promise.allSettled([writingBegin, ...(abortPromise ? [abortPromise] : [])]);
      renameSpy.mockRestore();
      service.dispose();
    }
  });

  it('keeps a differing replacement identity when backup races before deletion begins', async () => {
    const teamName = 'pre-boundary-replacement-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const manifestPath = path.join(hoisted.backupsBase, 'teams', teamName, 'manifest.json');
    const replacementIdentityId = 'replacement-owned-identity';
    const service = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Team' }), 'utf8');
    await service.initialize();
    await service.backupTeam(teamName);
    const originalConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      _backupIdentityId: string;
    };

    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Replacement Team',
        _backupIdentityId: replacementIdentityId,
      }),
      'utf8'
    );

    let signalReplacementRead!: () => void;
    let releaseReplacementRead!: () => void;
    const replacementRead = new Promise<void>((resolve) => {
      signalReplacementRead = resolve;
    });
    const replacementReadRelease = new Promise<void>((resolve) => {
      releaseReplacementRead = resolve;
    });
    const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
    let configOpenBlocked = false;
    const openSpy = vi.spyOn(nativeFs.promises, 'open').mockImplementation((async (
      file: nativeFs.PathLike,
      flags: string | number,
      ...args: unknown[]
    ) => {
      if (
        !configOpenBlocked &&
        flags === 'r' &&
        path.resolve(String(file)) === path.resolve(configPath)
      ) {
        configOpenBlocked = true;
        signalReplacementRead();
        await replacementReadRelease;
      }
      return realOpen(file, flags, ...(args as never[]));
    }) as typeof nativeFs.promises.open);

    const backupPromise = service.backupTeam(teamName);
    let beginPromise: Promise<
      Awaited<ReturnType<TeamBackupService['beginPermanentDeletion']>>
    > | null = null;
    try {
      await replacementRead;
      beginPromise = service.beginPermanentDeletion(teamName);
      releaseReplacementRead();

      await backupPromise;
      const prepared = await beginPromise;
      const replacementConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
        name: string;
        _backupIdentityId: string;
      };
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
        identityId: string;
      };

      expect(prepared.identityId).toBe(originalConfig._backupIdentityId);
      expect(replacementConfig).toMatchObject({
        name: 'Replacement Team',
        _backupIdentityId: replacementIdentityId,
      });
      expect(manifest.identityId).toBe(originalConfig._backupIdentityId);
      await expect(service.isPermanentDeletionTargetCurrent(prepared)).resolves.toBe(false);
      const deleting = await service.commitPermanentDeletionBoundary(prepared);
      await expect(service.isPermanentDeletionTargetCurrent(deleting)).resolves.toBe(false);
      await expect(service.completePermanentDeletion(deleting)).rejects.toThrow(
        'Permanent deletion cleanup is incomplete'
      );
      await expect(service.listPendingPermanentDeletions()).resolves.toEqual([
        expect.objectContaining({
          transactionId: deleting.transactionId,
          phase: 'deleting',
          completedTargets: [],
        }),
      ]);
      await service.backupTeam(teamName);
      const replacementManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
        identityId: string;
        status: string;
      };
      expect(replacementManifest).toMatchObject({
        identityId: replacementIdentityId,
        status: 'active',
      });
      await expect(fs.readFile(configPath, 'utf8')).resolves.toContain(replacementIdentityId);
    } finally {
      releaseReplacementRead();
      await Promise.allSettled([backupPromise, ...(beginPromise ? [beginPromise] : [])]);
      openSpy.mockRestore();
      service.dispose();
    }
  });

  it('does not overwrite a replacement config committed after restore observed it missing', async () => {
    const teamName = 'restore-config-replacement-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const backupDir = path.join(hoisted.backupsBase, 'teams', teamName);
    const replacementIdentityId = 'independent-replacement-id';
    const originalService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Restore Team' }), 'utf8');
    await originalService.initialize();
    await originalService.backupTeam(teamName);
    const originalIdentityId = (
      JSON.parse(await fs.readFile(configPath, 'utf8')) as { _backupIdentityId: string }
    )._backupIdentityId;
    originalService.dispose();
    await fs.rm(teamDir, { recursive: true, force: true });

    const realReaddir = nativeFs.promises.readdir.bind(nativeFs.promises);
    let installedReplacement = false;
    const readdirSpy = vi.spyOn(nativeFs.promises, 'readdir').mockImplementation((async (
      directoryPath: nativeFs.PathLike,
      options?: unknown
    ) => {
      const entries = await realReaddir(directoryPath, options as never);
      if (
        !installedReplacement &&
        path.resolve(String(directoryPath)) === path.resolve(backupDir)
      ) {
        installedReplacement = true;
        await fs.mkdir(teamDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            name: 'Independent Replacement Team',
            _backupIdentityId: replacementIdentityId,
          }),
          'utf8'
        );
      }
      return entries;
    }) as typeof nativeFs.promises.readdir);

    const recoveryService = new TeamBackupService();
    try {
      await recoveryService.initialize();
      const replacementConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
        name: string;
        _backupIdentityId: string;
      };
      expect(installedReplacement).toBe(true);
      expect(replacementConfig).toEqual({
        name: 'Independent Replacement Team',
        _backupIdentityId: replacementIdentityId,
      });

      const prepared = await recoveryService.beginPermanentDeletion(teamName);
      expect(prepared.identityId).toBe(originalIdentityId);
      await expect(recoveryService.isPermanentDeletionTargetCurrent(prepared)).resolves.toBe(false);
    } finally {
      readdirSpy.mockRestore();
      recoveryService.dispose();
    }
  });

  it('does not stamp a replacement marker committed after restore observed config missing', async () => {
    const teamName = 'restore-marker-replacement-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const markerPath = path.join(teamDir, '.permanent-deletion-identity.json');
    const backupDir = path.join(hoisted.backupsBase, 'teams', teamName);
    const replacementIdentityId = 'replacement-marker-identity';
    const originalService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Marker Team' }), 'utf8');
    await originalService.initialize();
    await originalService.backupTeam(teamName);
    originalService.dispose();
    await fs.rm(teamDir, { recursive: true, force: true });

    const realReaddir = nativeFs.promises.readdir.bind(nativeFs.promises);
    let installedMarker = false;
    const readdirSpy = vi.spyOn(nativeFs.promises, 'readdir').mockImplementation((async (
      directoryPath: nativeFs.PathLike,
      options?: unknown
    ) => {
      const entries = await realReaddir(directoryPath, options as never);
      if (!installedMarker && path.resolve(String(directoryPath)) === path.resolve(backupDir)) {
        installedMarker = true;
        await fs.mkdir(teamDir, { recursive: true });
        await fs.writeFile(
          markerPath,
          JSON.stringify({ version: 1, teamName, identityId: replacementIdentityId }),
          'utf8'
        );
      }
      return entries;
    }) as typeof nativeFs.promises.readdir);

    const recoveryService = new TeamBackupService();
    try {
      await recoveryService.initialize();
      expect(installedMarker).toBe(true);
      await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toContain(replacementIdentityId);
    } finally {
      readdirSpy.mockRestore();
      recoveryService.dispose();
    }
  });

  it('keeps an unproved deletion pending without fencing a different-tree replacement', async () => {
    const teamName = 'same-name-race-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const manifestPath = path.join(hoisted.backupsBase, 'teams', teamName, 'manifest.json');
    const firstService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Team' }), 'utf8');

    await firstService.initialize();
    await firstService.backupTeam(teamName);
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
    await fs.rm(teamDir, { recursive: true, force: true });

    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Replacement Team' }), 'utf8');
    vi.useFakeTimers();
    const backupSpy = vi.spyOn(firstService, 'backupTeam');
    firstService.scheduleTaskBackup(teamName, 'replacement-task.json');
    const recoveryCheckPromise = firstService.isPermanentDeletionTargetCurrent(deleting);
    await vi.advanceTimersByTimeAsync(500);
    expect(backupSpy).toHaveBeenCalledTimes(1);
    await backupSpy.mock.results[0].value;
    const recoverySawDeletedTarget = await recoveryCheckPromise;
    backupSpy.mockRestore();
    vi.useRealTimers();

    const replacementConfigBeforeRestart = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      name: string;
      _backupIdentityId?: string;
    };
    const replacementManifestBeforeRestart = JSON.parse(
      await fs.readFile(manifestPath, 'utf8')
    ) as {
      identityId: string;
      status: string;
    };
    expect(recoverySawDeletedTarget).toBe(false);
    expect(replacementConfigBeforeRestart).toMatchObject({ name: 'Replacement Team' });
    expect(replacementConfigBeforeRestart._backupIdentityId).not.toBe(deleting.identityId);
    expect(replacementManifestBeforeRestart).toMatchObject({
      identityId: replacementConfigBeforeRestart._backupIdentityId,
      status: 'active',
    });
    firstService.dispose();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();
    const [pending] = await recoveredService.listPendingPermanentDeletions();
    expect(pending).toMatchObject({
      teamName,
      identityId: deleting.identityId,
      phase: 'deleting',
    });
    await expect(recoveredService.isPermanentDeletionTargetCurrent(pending)).resolves.toBe(false);
    await expect(recoveredService.completePermanentDeletion(pending)).rejects.toThrow(
      'Permanent deletion cleanup is incomplete'
    );
    await recoveredService.backupTeam(teamName);

    const replacementConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      name: string;
      _backupIdentityId: string;
    };
    const replacementManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      identityId: string;
      status: string;
    };
    expect(replacementConfig._backupIdentityId).not.toBe(deleting.identityId);
    expect(replacementManifest).toMatchObject({
      identityId: replacementConfig._backupIdentityId,
      status: 'active',
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('Replacement Team');
    recoveredService.dispose();
  });

  it('keeps an exact durable tombstone without fencing a same-name replacement', async () => {
    const teamName = 'same-name-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const taskDir = path.join(hoisted.tasksBase, teamName);
    const taskPath = path.join(taskDir, 'original-task.json');
    const intentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    const firstService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Team' }), 'utf8');
    await fs.writeFile(taskPath, JSON.stringify({ subject: 'Original Task' }), 'utf8');

    await firstService.initialize();
    await firstService.backupTeam(teamName);
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
    await removePreparedDeletionTargets(firstService, deleting);
    await firstService.completePermanentDeletion(deleting);
    const tombstone = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      identityId: string;
      phase: string;
    };
    expect(tombstone).toMatchObject({ identityId: deleting.identityId, phase: 'deleted' });
    firstService.dispose();

    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Replacement Team' }), 'utf8');
    const replacementService = new TeamBackupService();
    await replacementService.initialize();
    await expect(fs.stat(taskPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await replacementService.backupTeam(teamName);

    const replacementConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      name: string;
      _backupIdentityId: string;
    };
    expect(replacementConfig.name).toBe('Replacement Team');
    expect(replacementConfig._backupIdentityId).not.toBe(deleting.identityId);
    replacementService.dispose();
  });

  it('skips quarantined and temporary OpenCode runtime files during backup', async () => {
    const service = new TeamBackupService();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const teamName = 'runtime-quarantine-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const runtimeDir = path.join(teamDir, '.opencode-runtime');
    const runtimeLaneIndex = {
      version: 1,
      updatedAt: '2026-04-22T12:00:00.000Z',
      lanes: {
        'secondary:opencode:tom': {
          laneId: 'secondary:opencode:tom',
          state: 'active',
          updatedAt: '2026-04-22T12:00:00.000Z',
        },
      },
    };

    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: 'Runtime Quarantine Team' }),
        'utf8'
      );
      await fs.writeFile(
        path.join(runtimeDir, 'lanes.json'),
        JSON.stringify(runtimeLaneIndex),
        'utf8'
      );
      await fs.writeFile(
        path.join(runtimeDir, 'lanes.invalid.123.json'),
        '{"version":1}\n}',
        'utf8'
      );
      await fs.writeFile(path.join(runtimeDir, '.tmp.deadbeef'), '{"partial":', 'utf8');

      await service.initialize();
      await service.backupTeam(teamName);

      const backupRuntimeDir = path.join(
        hoisted.backupsBase,
        'teams',
        teamName,
        '.opencode-runtime'
      );
      await expect(fs.readFile(path.join(backupRuntimeDir, 'lanes.json'), 'utf8')).resolves.toBe(
        JSON.stringify(runtimeLaneIndex)
      );
      await expect(
        fs.stat(path.join(backupRuntimeDir, 'lanes.invalid.123.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(backupRuntimeDir, '.tmp.deadbeef'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const manifest = JSON.parse(
        await fs.readFile(
          path.join(hoisted.backupsBase, 'teams', teamName, 'manifest.json'),
          'utf8'
        )
      ) as { fileStats: Record<string, unknown> };
      expect(
        Object.prototype.hasOwnProperty.call(
          manifest.fileStats,
          '.opencode-runtime/lanes.invalid.123.json'
        )
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(manifest.fileStats, '.opencode-runtime/.tmp.deadbeef')
      ).toBe(false);
      expect(
        warnSpy.mock.calls.some((args) =>
          args.some((arg) => String(arg).includes('Skipping invalid JSON'))
        )
      ).toBe(false);
    } finally {
      service.dispose();
      warnSpy.mockRestore();
    }
  });

  it('backs up member-scoped work sync status without copying the append-only journal', async () => {
    const service = new TeamBackupService();
    const teamName = 'member-work-sync-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const memberDir = path.join(teamDir, 'members', 'jack');
    const workSyncDir = path.join(memberDir, '.member-work-sync');
    const runtimeWorkSyncDir = path.join(teamDir, '.opencode-runtime', '.member-work-sync');
    const status = {
      teamName,
      memberName: 'jack',
      state: 'caught_up',
      evaluatedAt: '2026-04-30T12:00:00.000Z',
      agenda: { fingerprint: 'abc123', items: [] },
    };

    try {
      await fs.mkdir(workSyncDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: 'Member Work Sync Team' }),
        'utf8'
      );
      await fs.writeFile(
        path.join(memberDir, 'member.meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          memberName: 'jack',
          memberKey: 'jack',
          updatedAt: '2026-04-30T12:00:00.000Z',
        }),
        'utf8'
      );
      await fs.writeFile(
        path.join(workSyncDir, 'status.json'),
        JSON.stringify({ schemaVersion: 2, status }),
        'utf8'
      );
      await fs.writeFile(
        path.join(workSyncDir, 'journal.jsonl'),
        `${JSON.stringify({
          schemaVersion: 1,
          timestamp: '2026-04-30T12:00:00.000Z',
          teamName,
          memberName: 'jack',
          event: 'status_written',
          source: 'test',
        })}\n`,
        'utf8'
      );
      await fs.writeFile(path.join(workSyncDir, '.tmp.deadbeef'), '{"partial":', 'utf8');
      await fs.writeFile(path.join(workSyncDir, 'journal.jsonl.lock'), '123\n', 'utf8');
      await fs.mkdir(runtimeWorkSyncDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeWorkSyncDir, 'journal.jsonl'),
        '{"runtime":true}\n',
        'utf8'
      );
      const staleBackupJournalPath = path.join(
        hoisted.backupsBase,
        'teams',
        teamName,
        'members',
        'jack',
        '.member-work-sync',
        'journal.jsonl'
      );
      await fs.mkdir(path.dirname(staleBackupJournalPath), { recursive: true });
      await fs.writeFile(staleBackupJournalPath, '{"old":true}\n', 'utf8');

      await service.initialize();
      await service.backupTeam(teamName);

      const backupMemberDir = path.join(hoisted.backupsBase, 'teams', teamName, 'members', 'jack');
      await expect(
        fs.readFile(path.join(backupMemberDir, 'member.meta.json'), 'utf8')
      ).resolves.toBe(
        JSON.stringify({
          schemaVersion: 1,
          memberName: 'jack',
          memberKey: 'jack',
          updatedAt: '2026-04-30T12:00:00.000Z',
        })
      );
      await expect(
        fs.readFile(path.join(backupMemberDir, '.member-work-sync', 'status.json'), 'utf8')
      ).resolves.toBe(JSON.stringify({ schemaVersion: 2, status }));
      await expect(
        fs.stat(path.join(backupMemberDir, '.member-work-sync', 'journal.jsonl'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.stat(path.join(backupMemberDir, '.member-work-sync', '.tmp.deadbeef'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.stat(path.join(backupMemberDir, '.member-work-sync', 'journal.jsonl.lock'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.readFile(
          path.join(
            hoisted.backupsBase,
            'teams',
            teamName,
            '.opencode-runtime',
            '.member-work-sync',
            'journal.jsonl'
          ),
          'utf8'
        )
      ).resolves.toBe('{"runtime":true}\n');

      const manifest = JSON.parse(
        await fs.readFile(
          path.join(hoisted.backupsBase, 'teams', teamName, 'manifest.json'),
          'utf8'
        )
      ) as { fileStats: Record<string, unknown> };
      expect(
        Object.prototype.hasOwnProperty.call(
          manifest.fileStats,
          'members/jack/.member-work-sync/status.json'
        )
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(
          manifest.fileStats,
          'members/jack/.member-work-sync/journal.jsonl'
        )
      ).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('repeatedly recovers an expired lock owned by an unrelated recycled PID', async () => {
    const teamName = 'pid-reuse-lock-owner-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'PID Reuse Lock Owner Team',
        _backupIdentityId: 'pid-reuse-lock-owner-identity',
      }),
      'utf8'
    );
    const service = new TeamBackupService();
    await service.initialize();
    const unrelatedProcess = spawn(process.execPath, [
      '-e',
      "process.stdout.write('READY\\n'); setInterval(() => undefined, 1000)",
    ]);
    await new Promise<void>((resolve, reject) => {
      unrelatedProcess.once('error', reject);
      unrelatedProcess.stdout.once('data', () => resolve());
    });
    const lockPath = getPermanentDeletionLockPath(hoisted.backupsBase, 'intent-hierarchy');

    try {
      const removeStaleLock = (
        service as unknown as {
          removeStalePermanentDeletionLock(candidatePath: string): Promise<boolean>;
        }
      ).removeStalePermanentDeletionLock.bind(service);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await fs.writeFile(
          lockPath,
          `${JSON.stringify({
            version: 2,
            token: `stale-owner-with-reused-pid-${attempt}`,
            pid: unrelatedProcess.pid ?? 1,
            processInstanceId: `dead-process-instance-${attempt}`,
            createdAt: '2000-01-01T00:00:00.000Z',
            targetPath: path.resolve(hoisted.backupsBase),
          })}\n`,
          'utf8'
        );
        const expired = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, expired, expired);
        await expect(removeStaleLock(lockPath)).resolves.toBe(true);
        await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      unrelatedProcess.kill();
      await fs.rm(lockPath, { force: true });
      service.dispose();
    }
  });

  it('serializes a separate-process writer until shared ancestor fsync completes', async () => {
    const firstTeamName = 'first-process-writer';
    const secondTeamName = 'second-process-writer';
    const intentsDir = path.join(hoisted.backupsBase, 'permanent-deletion-intents');
    const firstIntentPath = path.join(intentsDir, `${encodeURIComponent(firstTeamName)}.json`);
    const secondIntentPath = path.join(intentsDir, `${encodeURIComponent(secondTeamName)}.json`);
    for (const [teamName, identityId] of [
      [firstTeamName, 'first-process-identity'],
      [secondTeamName, 'second-process-identity'],
    ]) {
      const teamDir = path.join(hoisted.teamsBase, teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: teamName, _backupIdentityId: identityId }),
        'utf8'
      );
    }

    const secondService = new TeamBackupService();
    await secondService.initialize();
    const childScript = `
      import * as nativeFs from 'node:fs';
      import * as path from 'node:path';
      const root = process.env.R9_PROOF_ROOT;
      const firstTeamName = process.env.R9_PROOF_TEAM;
      if (!root || !firstTeamName) throw new Error('missing proof environment');
      const pathDecoder = await import('./src/main/utils/pathDecoder.ts');
      pathDecoder.setClaudeBasePathOverride(root);
      pathDecoder.setAppDataBasePath(root);
      const { TeamBackupService } =
        await import('./src/main/services/team/TeamBackupService.ts');
      const service = new TeamBackupService();
      await service.initialize();
      await nativeFs.promises.rm(path.join(root, 'backups'), {
        recursive: true,
        force: true,
      });
      const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
      let blocked = false;
      nativeFs.promises.open = async (filePath, flags, ...args) => {
        if (
          !blocked &&
          path.resolve(String(filePath)) === path.resolve(root) &&
          flags === 'r'
        ) {
          blocked = true;
          const handle = await realOpen(filePath, flags, ...args);
          return {
            sync: async () => {
              process.stdout.write('SYNC_STARTED\\n');
              await new Promise((resolve) => process.stdin.once('data', resolve));
              await handle.sync();
            },
            close: () => handle.close(),
          };
        }
        return realOpen(filePath, flags, ...args);
      };
      await service.beginPermanentDeletion(firstTeamName);
      process.stdout.write('DONE\\n');
      service.dispose();
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          R9_PROOF_ROOT: tempDir,
          R9_PROOF_TEAM: firstTeamName,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let childStdout = '';
    let childStderr = '';
    let signalSyncStarted!: () => void;
    let signalDone!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      signalSyncStarted = resolve;
    });
    const childDone = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      childStdout += chunk.toString('utf8');
      if (childStdout.includes('SYNC_STARTED\n')) signalSyncStarted();
      if (childStdout.includes('DONE\n')) signalDone();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString('utf8');
    });

    let secondBegin: Promise<unknown> | null = null;
    try {
      await syncStarted;
      secondBegin = secondService.beginPermanentDeletion(secondTeamName);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();

      await expect(fs.stat(firstIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(secondIntentPath)).rejects.toMatchObject({ code: 'ENOENT' });

      child.stdin.write('release\n');
      await childDone;
      await expect(secondBegin).resolves.toMatchObject({ teamName: secondTeamName });
      await expect(fs.stat(firstIntentPath)).resolves.toBeDefined();
      await expect(fs.stat(secondIntentPath)).resolves.toBeDefined();
      expect(childStderr).toBe('');
    } finally {
      child.stdin.write('release\n');
      child.kill();
      await secondBegin?.catch(() => undefined);
      secondService.dispose();
    }
  });

  it('does not clobber a replacement published at corrupt restore commit', async () => {
    const teamName = 'restore-corrupt-final-gap-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const replacement = JSON.stringify({
      name: 'Final Gap Replacement',
      _backupIdentityId: 'final-gap-replacement-id',
    });
    const originalService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Final Gap Team' }), 'utf8');
    await originalService.initialize();
    await originalService.backupTeam(teamName);
    originalService.dispose();
    await fs.writeFile(configPath, '{"name":', 'utf8');

    const realLink = nativeFs.promises.link.bind(nativeFs.promises);
    let installedReplacement = false;
    const linkSpy = vi
      .spyOn(nativeFs.promises, 'link')
      .mockImplementation(async (source, target) => {
        if (!installedReplacement && path.resolve(String(target)) === path.resolve(configPath)) {
          installedReplacement = true;
          await fs.writeFile(configPath, replacement, 'utf8');
        }
        return realLink(source, target);
      });

    const recoveryService = new TeamBackupService();
    try {
      await recoveryService.initialize();
      expect(installedReplacement).toBe(true);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(replacement);
    } finally {
      linkSpy.mockRestore();
      recoveryService.dispose();
    }
  });

  it('does not stamp replacement files after full restore commits config', async () => {
    const teamName = 'restore-post-config-replacement-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const membersPath = path.join(teamDir, 'members.meta.json');
    const backupMembersPath = path.join(
      hoisted.backupsBase,
      'teams',
      teamName,
      'members.meta.json'
    );
    const originalService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Original Restore Team' }), 'utf8');
    await fs.writeFile(membersPath, JSON.stringify({ owner: 'original' }), 'utf8');
    await originalService.initialize();
    await originalService.backupTeam(teamName);
    originalService.dispose();
    await fs.rm(teamDir, { recursive: true, force: true });

    const realReadFile = nativeFs.promises.readFile.bind(nativeFs.promises);
    let installedReplacement = false;
    const readFileSpy = vi.spyOn(nativeFs.promises, 'readFile').mockImplementation(((
      file: unknown,
      ...args: unknown[]
    ) => {
      const read = realReadFile(file as never, ...(args as never[])) as Promise<unknown>;
      if (!installedReplacement && path.resolve(String(file)) === path.resolve(backupMembersPath)) {
        installedReplacement = true;
        return read.then(async (value) => {
          await fs.writeFile(
            configPath,
            JSON.stringify({
              name: 'Concurrent Replacement Team',
              _backupIdentityId: 'concurrent-replacement-identity',
            }),
            'utf8'
          );
          await fs.writeFile(membersPath, JSON.stringify({ owner: 'replacement' }), 'utf8');
          return value;
        }) as never;
      }
      return read as never;
    }) as never);

    const recoveryService = new TeamBackupService();
    try {
      await recoveryService.initialize();
      expect(installedReplacement).toBe(true);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toContain(
        'Concurrent Replacement Team'
      );
      await expect(fs.readFile(membersPath, 'utf8')).resolves.toContain('"replacement"');
    } finally {
      readFileSpy.mockRestore();
      recoveryService.dispose();
    }
  });

  it('serializes periodic publication before an external deletion boundary', async () => {
    const teamName = 'external-deletion-periodic-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const kanbanPath = path.join(teamDir, 'kanban-state.json');
    const backupDataPath = path.join(hoisted.backupsBase, 'teams', teamName, 'kanban-state.json');
    const manifestPath = path.join(hoisted.backupsBase, 'teams', teamName, 'manifest.json');
    const registryPath = path.join(hoisted.backupsBase, 'registry.json');
    const intentPath = path.join(
      hoisted.backupsBase,
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'External Deletion Team' }), 'utf8');
    await fs.writeFile(kanbanPath, JSON.stringify({ value: 'initial' }), 'utf8');

    const periodicService = new TeamBackupService();
    const deletionService = new TeamBackupService();
    await periodicService.initialize();
    await periodicService.backupTeam(teamName);
    await deletionService.initialize();
    await fs.writeFile(
      kanbanPath,
      JSON.stringify({ value: 'Changed after initial backup' }),
      'utf8'
    );

    let signalBackupCommitBlocked!: () => void;
    let releaseBackupCommit!: () => void;
    const backupCommitBlocked = new Promise<void>((resolve) => {
      signalBackupCommitBlocked = resolve;
    });
    const backupCommitRelease = new Promise<void>((resolve) => {
      releaseBackupCommit = resolve;
    });
    const teamLockPath = getPermanentDeletionLockPath(hoisted.backupsBase, `team:${teamName}`);
    let signalDeletionLockAttempted!: () => void;
    const deletionLockAttempted = new Promise<void>((resolve) => {
      signalDeletionLockAttempted = resolve;
    });
    let teamLockPublishAttempts = 0;
    let deletionAcquiredWhileBackupBlocked = false;
    const publicationOrder: string[] = [];
    let backupCommitWasBlocked = false;
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        const resolvedDestination = path.resolve(String(destinationPath));
        if (resolvedDestination === path.resolve(teamLockPath)) {
          teamLockPublishAttempts += 1;
        }
        if (teamLockPublishAttempts === 2 && resolvedDestination === path.resolve(teamLockPath)) {
          try {
            await realRename(sourcePath, destinationPath);
            deletionAcquiredWhileBackupBlocked = true;
            signalDeletionLockAttempted();
            return;
          } catch (error) {
            signalDeletionLockAttempted();
            throw error;
          }
        }
        let deletingIntent = false;
        if (resolvedDestination === path.resolve(intentPath)) {
          try {
            const candidate = JSON.parse(await fs.readFile(String(sourcePath), 'utf8')) as {
              phase?: unknown;
            };
            deletingIntent = candidate.phase === 'deleting';
          } catch {
            // The production write reports malformed data; this hook only records valid intents.
          }
        }
        if (!backupCommitWasBlocked && resolvedDestination === path.resolve(backupDataPath)) {
          backupCommitWasBlocked = true;
          signalBackupCommitBlocked();
          await backupCommitRelease;
        }
        await realRename(sourcePath, destinationPath);
        if (resolvedDestination === path.resolve(backupDataPath)) {
          publicationOrder.push('backup-data');
        } else if (resolvedDestination === path.resolve(manifestPath)) {
          publicationOrder.push('backup-manifest');
        } else if (resolvedDestination === path.resolve(registryPath)) {
          publicationOrder.push('backup-registry');
        } else if (deletingIntent) {
          publicationOrder.push('deletion-marker');
        }
      });

    const runPeriodicBackup = (
      periodicService as unknown as { runPeriodicBackup(): Promise<void> }
    ).runPeriodicBackup.bind(periodicService);
    const periodicBackup = runPeriodicBackup();
    let deletionBoundary: Promise<unknown> | null = null;
    try {
      await backupCommitBlocked;

      deletionBoundary = (async () => {
        const prepared = await deletionService.beginPermanentDeletion(teamName);
        return deletionService.commitPermanentDeletionBoundary(prepared);
      })();
      await deletionLockAttempted;
      if (deletionAcquiredWhileBackupBlocked) {
        await deletionBoundary;
      }

      releaseBackupCommit();
      await periodicBackup;
      await deletionBoundary;

      const deletionMarkerIndex = publicationOrder.indexOf('deletion-marker');
      expect(backupCommitWasBlocked).toBe(true);
      expect(deletionAcquiredWhileBackupBlocked).toBe(false);
      expect(deletionMarkerIndex).toBeGreaterThan(-1);
      for (const publication of ['backup-data', 'backup-manifest', 'backup-registry']) {
        const publicationIndex = publicationOrder.lastIndexOf(publication);
        expect(publicationIndex).toBeGreaterThan(-1);
        expect(publicationIndex).toBeLessThan(deletionMarkerIndex);
      }
      await expect(fs.readFile(backupDataPath, 'utf8')).resolves.toContain(
        'Changed after initial backup'
      );
    } finally {
      releaseBackupCommit();
      await Promise.allSettled([periodicBackup, ...(deletionBoundary ? [deletionBoundary] : [])]);
      renameSpy.mockRestore();
      deletionService.dispose();
      periodicService.dispose();
    }
  });

  it('reloads an external durable tombstone before an initialized instance restores', async () => {
    const teamName = 'stale-module-restore-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const configPath = path.join(teamDir, 'config.json');
    const staleRestoreService = new TeamBackupService();
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Stale Module Original' }), 'utf8');
    await staleRestoreService.initialize();
    await staleRestoreService.backupTeam(teamName);

    vi.resetModules();
    const independentlyLoaded =
      await import('../../../../src/main/services/team/TeamBackupService');
    const deletionService = new independentlyLoaded.TeamBackupService();
    try {
      await deletionService.initialize();
      const prepared = await deletionService.beginPermanentDeletion(teamName);
      const deleting = await deletionService.commitPermanentDeletionBoundary(prepared);
      await removePreparedDeletionTargets(deletionService, deleting);
      await deletionService.completePermanentDeletion(deleting);

      const restored = await staleRestoreService.restoreIfNeeded();
      expect(restored).not.toContain(teamName);
      await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      deletionService.dispose();
      staleRestoreService.dispose();
    }
  });
});
