import * as nativeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';
import {
  getAppDataPath,
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('team attachment permanent deletion', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-attachment-delete-'));
    setAppDataBasePath(tempDir);
    setClaudeBasePathOverride(tempDir);
  });

  afterEach(async () => {
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('awaits removal of message and task attachment trees without touching another team', async () => {
    const appDataPath = getAppDataPath();
    const targetMessageDir = path.join(appDataPath, 'attachments', 'target-team', 'message-1');
    const targetTaskDir = path.join(appDataPath, 'task-attachments', 'target-team', 'task-1');
    const siblingMessageFile = path.join(
      appDataPath,
      'attachments',
      'sibling-team',
      'message-1.json'
    );
    const siblingTaskFile = path.join(
      appDataPath,
      'task-attachments',
      'sibling-team',
      'task-1',
      'attachment--file.txt'
    );
    await fs.mkdir(targetMessageDir, { recursive: true });
    await fs.mkdir(targetTaskDir, { recursive: true });
    await fs.mkdir(path.dirname(siblingMessageFile), { recursive: true });
    await fs.mkdir(path.dirname(siblingTaskFile), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(targetMessageDir, 'attachment--image.png'), 'message'),
      fs.writeFile(path.join(targetTaskDir, 'attachment--file.txt'), 'task'),
      fs.writeFile(siblingMessageFile, 'sibling-message'),
      fs.writeFile(siblingTaskFile, 'sibling-task'),
    ]);

    await new TeamAttachmentStore().deleteTeamAttachments('target-team');
    await new TeamTaskAttachmentStore().deleteTeamAttachments('target-team');

    await expect(
      fs.stat(path.join(appDataPath, 'attachments', 'target-team'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(appDataPath, 'task-attachments', 'target-team'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(siblingMessageFile, 'utf8')).resolves.toBe('sibling-message');
    await expect(fs.readFile(siblingTaskFile, 'utf8')).resolves.toBe('sibling-task');
  });

  it('preserves both attachment trees when the exact deletion fence changes', async () => {
    const appDataPath = getAppDataPath();
    const messageFile = path.join(appDataPath, 'attachments', 'replacement-team', 'message-1.json');
    const taskFile = path.join(
      appDataPath,
      'task-attachments',
      'replacement-team',
      'task-1',
      'attachment--file.txt'
    );
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await fs.mkdir(path.dirname(taskFile), { recursive: true });
    await fs.writeFile(messageFile, 'replacement-message');
    await fs.writeFile(taskFile, 'replacement-task');

    await expect(
      new TeamAttachmentStore().deleteTeamAttachments('replacement-team', () =>
        Promise.resolve(false)
      )
    ).resolves.toBe(false);
    await expect(
      new TeamTaskAttachmentStore().deleteTeamAttachments('replacement-team', () =>
        Promise.resolve(false)
      )
    ).resolves.toBe(false);

    await expect(fs.readFile(messageFile, 'utf8')).resolves.toBe('replacement-message');
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('replacement-task');
  });

  it('preserves a replacement published over the public reservation during validation', async () => {
    const teamName = 'reservation-replacement-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    const replacementFile = path.join(teamDir, 'replacement-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');

    let replacementPublished = false;
    const deleted = await new TeamAttachmentStore().deleteTeamAttachments(teamName, async () => {
      const reservation = await fs.lstat(teamDir);
      expect(reservation.isSymbolicLink()).toBe(true);
      await fs.unlink(teamDir);
      await fs.mkdir(teamDir);
      await fs.writeFile(replacementFile, 'replacement-message');
      replacementPublished = true;
      return true;
    });

    expect(deleted).toBe(true);
    expect(replacementPublished).toBe(true);
    await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-message');
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only the detached reservation when replacement wins at cleanup', async () => {
    const teamName = 'reservation-cleanup-interleaving-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    const replacementFile = path.join(teamDir, 'replacement-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');

    const realRm = nativeFs.promises.rm.bind(nativeFs.promises);
    const realLstat = nativeFs.promises.lstat.bind(nativeFs.promises);
    let replacementPublished = false;
    const rmSpy = vi
      .spyOn(nativeFs.promises, 'rm')
      .mockImplementation(async (candidatePath, options) => {
        if (!replacementPublished) {
          const resolvedCandidate = path.resolve(String(candidatePath));
          const candidate = await realLstat(candidatePath).catch(() => null);
          const isReservationCleanup =
            resolvedCandidate === path.resolve(teamDir) ||
            (candidate?.isSymbolicLink() === true &&
              path.basename(resolvedCandidate).includes('.deleting.'));
          if (isReservationCleanup) {
            if (resolvedCandidate === path.resolve(teamDir)) {
              await fs.unlink(teamDir);
            }
            await fs.mkdir(teamDir);
            await fs.writeFile(replacementFile, 'replacement-message');
            replacementPublished = true;
          }
        }
        return realRm(candidatePath, options);
      });

    try {
      await expect(
        new TeamAttachmentStore().deleteTeamAttachments(teamName, () => Promise.resolve(true))
      ).resolves.toBe(true);
      expect(replacementPublished).toBe(true);
      await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-message');
      await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('preserves team, task, and attachment replacements published at deletion', async () => {
    const teamName = 'replacement-race-team';
    const appDataPath = getAppDataPath();
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const tasksDir = path.join(getTasksBasePath(), teamName);
    const messageTeamDir = path.join(appDataPath, 'attachments', teamName);
    const taskAttachmentTeamDir = path.join(appDataPath, 'task-attachments', teamName);
    const replacementConfig = path.join(teamDir, 'config.json');
    const replacementTask = path.join(tasksDir, 'replacement-task.json');
    const replacementMessage = path.join(messageTeamDir, 'replacement-message.json');
    const replacementTaskAttachment = path.join(
      taskAttachmentTeamDir,
      'task-1',
      'replacement--file.txt'
    );

    for (const [root, fileName] of [
      [teamDir, 'config.json'],
      [tasksDir, 'old-task.json'],
      [messageTeamDir, 'old-message.json'],
      [taskAttachmentTeamDir, 'old-attachment.txt'],
    ]) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, fileName),
        root === teamDir ? JSON.stringify({ name: 'Old Team' }) : 'old'
      );
    }

    const backupService = new TeamBackupService();
    await backupService.initialize();
    const prepared = await backupService.beginPermanentDeletion(teamName);
    const deleting = await backupService.commitPermanentDeletionBoundary(prepared);

    const replacements = new Map<string, { filePath: string; content: string }>([
      [
        path.resolve(teamDir),
        {
          filePath: replacementConfig,
          content: JSON.stringify({ name: 'Replacement Team' }),
        },
      ],
      [path.resolve(tasksDir), { filePath: replacementTask, content: '{"subject":"replacement"}' }],
      [
        path.resolve(messageTeamDir),
        { filePath: replacementMessage, content: 'replacement-message' },
      ],
      [
        path.resolve(taskAttachmentTeamDir),
        { filePath: replacementTaskAttachment, content: 'replacement-task-attachment' },
      ],
    ]);
    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        await realRename(sourcePath, destinationPath);
        const replacement = replacements.get(path.resolve(String(sourcePath)));
        if (replacement) {
          await fs.mkdir(path.dirname(replacement.filePath), { recursive: true });
          await fs.writeFile(replacement.filePath, replacement.content);
        }
      });

    try {
      const dataService = Object.create(TeamDataService.prototype) as TeamDataService;
      (
        dataService as unknown as {
          invalidateNotificationContext(team: string): void;
        }
      ).invalidateNotificationContext = () => undefined;
      await expect(
        backupService.withPermanentDeletionTargetFence(deleting, async (isTargetCurrent) => {
          if (
            !(await dataService.permanentlyDeleteTeam(
              teamName,
              (detachedPath) => isTargetCurrent('team-data', detachedPath),
              (detachedPath) => isTargetCurrent('task-data', detachedPath)
            ))
          ) {
            return false;
          }
          if (
            !(await new TeamAttachmentStore().deleteTeamAttachments(teamName, (detachedPath) =>
              isTargetCurrent('message-attachments', detachedPath)
            ))
          ) {
            return false;
          }
          return new TeamTaskAttachmentStore().deleteTeamAttachments(teamName, (detachedPath) =>
            isTargetCurrent('task-attachments', detachedPath)
          );
        })
      ).resolves.toBe(true);

      await expect(fs.readFile(replacementConfig, 'utf8')).resolves.toContain('Replacement Team');
      await expect(fs.readFile(replacementTask, 'utf8')).resolves.toContain('replacement');
      await expect(fs.readFile(replacementMessage, 'utf8')).resolves.toBe('replacement-message');
      await expect(fs.readFile(replacementTaskAttachment, 'utf8')).resolves.toBe(
        'replacement-task-attachment'
      );
    } finally {
      renameSpy.mockRestore();
      backupService.dispose();
    }
  });

  it('resumes only remaining exact targets after restart and completes the tombstone last', async () => {
    const teamName = 'restart-cleanup-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const tasksDir = path.join(getTasksBasePath(), teamName);
    const messageDir = path.join(getAppDataPath(), 'attachments', teamName);
    const taskAttachmentDir = path.join(getAppDataPath(), 'task-attachments', teamName);
    const intentPath = path.join(
      getBackupsBasePath(),
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    await Promise.all([
      fs.mkdir(teamDir, { recursive: true }),
      fs.mkdir(tasksDir, { recursive: true }),
      fs.mkdir(messageDir, { recursive: true }),
      fs.mkdir(taskAttachmentDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({ name: 'Original Team' })),
      fs.writeFile(
        path.join(tasksDir, 'task-1.json'),
        JSON.stringify({ subject: 'Original Task' })
      ),
      fs.writeFile(path.join(messageDir, 'message-1.json'), 'original-message-attachment'),
      fs.writeFile(path.join(taskAttachmentDir, 'attachment-1.txt'), 'original-task-attachment'),
    ]);

    const dataService = Object.create(TeamDataService.prototype) as TeamDataService;
    (
      dataService as unknown as {
        invalidateNotificationContext(team: string): void;
      }
    ).invalidateNotificationContext = () => undefined;
    const firstService = new TeamBackupService();
    await firstService.initialize();
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);

    await expect(
      firstService.withPermanentDeletionTargetFence(
        deleting,
        async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
          await expect(
            dataService.permanentlyDeleteTeam(
              teamName,
              (detachedPath) => isTargetCurrent('team-data', detachedPath),
              (detachedPath) => isTargetCurrent('task-data', detachedPath),
              {
                teamDataProofHooks: getTargetProofHooks('team-data'),
                taskDataProofHooks: getTargetProofHooks('task-data'),
              }
            )
          ).resolves.toBe(true);
          expect(isTargetCompleted('team-data')).toBe(true);
          expect(isTargetCompleted('task-data')).toBe(true);
          throw new Error('fixture attachment cleanup failure');
        }
      )
    ).rejects.toThrow('fixture attachment cleanup failure');
    firstService.dispose();

    const failedIntent = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(failedIntent).toMatchObject({
      phase: 'deleting',
      completedTargets: ['team-data', 'task-data'],
      cleanupCompleted: false,
    });
    await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(tasksDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(messageDir)).resolves.toBeDefined();
    await expect(fs.stat(taskAttachmentDir)).resolves.toBeDefined();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();
    const [recovered] = await recoveredService.listPendingPermanentDeletions();
    await expect(recoveredService.completePermanentDeletion(recovered)).rejects.toThrow(
      'Permanent deletion cleanup is incomplete'
    );
    const stillPendingIntent = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      cleanupCompleted: boolean;
    };
    expect(stillPendingIntent).toMatchObject({
      phase: 'deleting',
      cleanupCompleted: false,
    });

    const replacementConfig = path.join(teamDir, 'config.json');
    const replacementTask = path.join(tasksDir, 'replacement-task.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      replacementConfig,
      JSON.stringify({
        name: 'Replacement Team',
        _backupIdentityId: 'replacement-team-identity',
      })
    );
    await fs.writeFile(replacementTask, JSON.stringify({ subject: 'Replacement Task' }));

    await expect(
      recoveredService.withPermanentDeletionTargetFence(
        recovered,
        async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
          expect(isTargetCompleted('team-data')).toBe(true);
          expect(isTargetCompleted('task-data')).toBe(true);
          expect(isTargetCompleted('message-attachments')).toBe(false);
          expect(isTargetCompleted('task-attachments')).toBe(false);

          const messageRemoved = await new TeamAttachmentStore().deleteTeamAttachments(
            teamName,
            (detachedPath) => isTargetCurrent('message-attachments', detachedPath),
            getTargetProofHooks('message-attachments')
          );
          expect(messageRemoved).toBe(true);
          const taskAttachmentRemoved = await new TeamTaskAttachmentStore().deleteTeamAttachments(
            teamName,
            (detachedPath) => isTargetCurrent('task-attachments', detachedPath),
            getTargetProofHooks('task-attachments')
          );
          expect(taskAttachmentRemoved).toBe(true);
          return (
            isTargetCompleted('team-data') &&
            isTargetCompleted('task-data') &&
            isTargetCompleted('message-attachments') &&
            isTargetCompleted('task-attachments')
          );
        }
      )
    ).resolves.toBe(true);

    const cleanupCompletedIntent = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(cleanupCompletedIntent).toMatchObject({
      phase: 'deleting',
      completedTargets: ['team-data', 'task-data', 'message-attachments', 'task-attachments'],
      cleanupCompleted: true,
    });
    await expect(fs.readFile(replacementConfig, 'utf8')).resolves.toContain('Replacement Team');
    await expect(fs.readFile(replacementTask, 'utf8')).resolves.toContain('Replacement Task');
    await expect(fs.stat(messageDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(taskAttachmentDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await recoveredService.completePermanentDeletion(recovered);
    const completedTombstone = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      cleanupCompleted: boolean;
    };
    expect(completedTombstone).toMatchObject({
      phase: 'deleted',
      cleanupCompleted: true,
    });
    recoveredService.dispose();
  });

  it.each([
    {
      crashWindow: 'rename before detached proof',
      persistDetachedProof: false,
      publishReplacement: false,
    },
    {
      crashWindow: 'durable detached proof before removal',
      persistDetachedProof: true,
      publishReplacement: true,
    },
  ])(
    'restarts from the exact transaction tree after $crashWindow without rejoining it',
    async ({ persistDetachedProof, publishReplacement }) => {
      const teamName = persistDetachedProof
        ? 'restart-durable-detached-team'
        : 'restart-rename-before-proof-team';
      const teamsBasePath = getTeamsBasePath();
      const teamDir = path.join(teamsBasePath, teamName);
      const originalFile = path.join(teamDir, 'nested', 'original.txt');
      const replacementFile = path.join(teamDir, 'replacement.txt');
      const unrelatedDir = path.join(
        teamsBasePath,
        `.${teamName}.permanent-deletion.00000000-0000-4000-8000-000000000000.team-data`
      );
      const unrelatedFile = path.join(unrelatedDir, 'unrelated.txt');
      const intentPath = path.join(
        getBackupsBasePath(),
        'permanent-deletion-intents',
        `${encodeURIComponent(teamName)}.json`
      );
      await fs.mkdir(path.dirname(originalFile), { recursive: true });
      await fs.mkdir(unrelatedDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: 'Original Restart Team' })
      );
      await fs.writeFile(originalFile, 'transaction-owned-original');
      await fs.writeFile(unrelatedFile, 'unrelated-sibling');

      const firstService = new TeamBackupService();
      await firstService.initialize();
      const prepared = await firstService.beginPermanentDeletion(teamName);
      const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
      let detachedPath = '';

      await firstService.withPermanentDeletionTargetFence(
        deleting,
        async (_isTargetCurrent, getTargetProofHooks) => {
          const proofHooks = getTargetProofHooks('team-data');
          detachedPath = proofHooks.detachedPath;
          await fs.rename(teamDir, detachedPath);
          if (persistDetachedProof) {
            const detachedStats = await fs.lstat(detachedPath);
            await proofHooks.onDetachedValidated(detachedPath, {
              dev: detachedStats.dev,
              ino: detachedStats.ino,
              birthtimeMs: detachedStats.birthtimeMs,
            });
          }
          return false;
        }
      );

      if (publishReplacement) {
        await fs.mkdir(teamDir);
        await fs.writeFile(
          path.join(teamDir, 'config.json'),
          JSON.stringify({
            name: 'Replacement Restart Team',
            _backupIdentityId: 'replacement-restart-team-identity',
          })
        );
        await fs.writeFile(replacementFile, 'replacement-survives');
      }
      firstService.dispose();

      const recoveredService = new TeamBackupService();
      await recoveredService.initialize();
      const [recovered] = await recoveredService.listPendingPermanentDeletions();
      expect(recovered).toMatchObject({
        teamName,
        transactionId: deleting.transactionId,
        phase: 'deleting',
        targetRemovalProofs: persistDetachedProof ? { 'team-data': { state: 'detached' } } : {},
      });
      await expect(recoveredService.isPermanentDeletionTargetCurrent(recovered)).resolves.toBe(
        true
      );

      const dataService = Object.create(TeamDataService.prototype) as TeamDataService;
      (
        dataService as unknown as {
          invalidateNotificationContext(team: string): void;
        }
      ).invalidateNotificationContext = () => undefined;
      const resumeExactDeletion = (): Promise<boolean> =>
        recoveredService.withPermanentDeletionTargetFence(
          recovered,
          async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
            expect(isTargetCompleted('team-data')).toBe(false);
            return dataService.permanentlyDeleteTeam(
              teamName,
              (candidatePath) => isTargetCurrent('team-data', candidatePath),
              (candidatePath) => isTargetCurrent('task-data', candidatePath),
              {
                skipTaskData: true,
                teamDataProofHooks: getTargetProofHooks('team-data'),
              }
            );
          }
        );

      const realRm = nativeFs.promises.rm.bind(nativeFs.promises);
      let retryInjected = false;
      const rmSpy = vi
        .spyOn(nativeFs.promises, 'rm')
        .mockImplementation(async (candidatePath, options) => {
          if (
            !retryInjected &&
            path.resolve(String(candidatePath)) === path.resolve(detachedPath)
          ) {
            retryInjected = true;
            throw Object.assign(new Error('fixture transient detached removal failure'), {
              code: 'EBUSY',
            });
          }
          return realRm(candidatePath, options);
        });

      try {
        await expect(resumeExactDeletion()).rejects.toThrow(
          'fixture transient detached removal failure'
        );
        expect(retryInjected).toBe(true);
        await expect(fs.readFile(originalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          fs.readFile(path.join(detachedPath, 'nested', 'original.txt'), 'utf8')
        ).resolves.toBe('transaction-owned-original');
        await expect(fs.readFile(unrelatedFile, 'utf8')).resolves.toBe('unrelated-sibling');
        if (publishReplacement) {
          await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-survives');
        } else {
          await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
        }

        await expect(resumeExactDeletion()).resolves.toBe(true);
      } finally {
        rmSpy.mockRestore();
      }

      const removedIntent = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
        targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
        completedTargets: string[];
        cleanupCompleted: boolean;
      };
      expect(removedIntent).toMatchObject({
        targetRemovalProofs: {
          'team-data': {
            state: 'removed',
            transactionId: deleting.transactionId,
          },
        },
        completedTargets: ['team-data'],
        cleanupCompleted: true,
      });
      await expect(fs.stat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(unrelatedFile, 'utf8')).resolves.toBe('unrelated-sibling');

      await recoveredService.completePermanentDeletion(recovered);
      await expect(
        fs.readFile(intentPath, 'utf8').then((raw) => JSON.parse(raw) as { phase: string })
      ).resolves.toMatchObject({ phase: 'deleted' });
      await expect(recoveredService.isPermanentDeletionTargetCurrent(recovered)).resolves.toBe(
        !publishReplacement
      );
      if (publishReplacement) {
        await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-survives');
      } else {
        await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      recoveredService.dispose();
    }
  );

  it('does not forge completion when the exact tree is renamed away, reconciled, restored, and restarted', async () => {
    const teamName = 'rename-away-restart-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const renamedTeamDir = path.join(getTeamsBasePath(), `.${teamName}.temporarily-away`);
    const originalFile = path.join(teamDir, 'nested', 'original.txt');
    const intentPath = path.join(
      getBackupsBasePath(),
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    await fs.mkdir(path.dirname(originalFile), { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'Rename Away Team' })
    );
    await fs.writeFile(originalFile, 'exact-original-tree');

    const dataService = Object.create(TeamDataService.prototype) as TeamDataService;
    (
      dataService as unknown as {
        invalidateNotificationContext(team: string): void;
      }
    ).invalidateNotificationContext = () => undefined;

    const firstService = new TeamBackupService();
    await firstService.initialize();
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
    const originalIdentity = await fs.lstat(teamDir);

    await fs.rename(teamDir, renamedTeamDir);
    const reconciled = await firstService.reconcilePermanentDeletionProgress(deleting);
    expect(reconciled).toMatchObject({
      phase: 'deleting',
      targetRemovalProofs: {},
      completedTargets: [],
      cleanupCompleted: false,
    });
    await expect(firstService.completePermanentDeletion(reconciled)).rejects.toThrow(
      'Permanent deletion cleanup is incomplete'
    );
    const notCompleted = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      targetRemovalProofs: Record<string, unknown>;
      completedTargets: string[];
    };
    expect(notCompleted).toMatchObject({
      phase: 'deleting',
      targetRemovalProofs: {},
      completedTargets: [],
    });

    await fs.rename(renamedTeamDir, teamDir);
    const restoredIdentity = await fs.lstat(teamDir);
    expect({
      dev: restoredIdentity.dev,
      ino: restoredIdentity.ino,
      birthtimeMs: restoredIdentity.birthtimeMs,
    }).toEqual({
      dev: originalIdentity.dev,
      ino: originalIdentity.ino,
      birthtimeMs: originalIdentity.birthtimeMs,
    });
    await expect(fs.readFile(originalFile, 'utf8')).resolves.toBe('exact-original-tree');
    firstService.dispose();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();
    const [recovered] = await recoveredService.listPendingPermanentDeletions();
    expect(recovered).toMatchObject({
      transactionId: deleting.transactionId,
      phase: 'deleting',
      completedTargets: [],
      cleanupCompleted: false,
    });
    await expect(
      recoveredService.withPermanentDeletionTargetFence(
        recovered,
        async (isTargetCurrent, getTargetProofHooks, isTargetCompleted) => {
          expect(isTargetCompleted('team-data')).toBe(false);
          expect(isTargetCompleted('task-data')).toBe(true);
          return dataService.permanentlyDeleteTeam(
            teamName,
            (detachedPath) => isTargetCurrent('team-data', detachedPath),
            (detachedPath) => isTargetCurrent('task-data', detachedPath),
            {
              skipTaskData: true,
              teamDataProofHooks: getTargetProofHooks('team-data'),
            }
          );
        }
      )
    ).resolves.toBe(true);

    await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const exactlyRemoved = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      phase: string;
      targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(exactlyRemoved).toMatchObject({
      phase: 'deleting',
      targetRemovalProofs: {
        'team-data': {
          state: 'removed',
          transactionId: deleting.transactionId,
        },
      },
      completedTargets: ['team-data'],
      cleanupCompleted: true,
    });

    await recoveredService.completePermanentDeletion(recovered);
    await expect(
      fs.readFile(intentPath, 'utf8').then((raw) => JSON.parse(raw) as { phase: string })
    ).resolves.toMatchObject({ phase: 'deleted' });
    recoveredService.dispose();
  });

  it('recovers an exact removal only from its durable transaction detach proof', async () => {
    const teamName = 'durable-detach-proof-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const intentPath = path.join(
      getBackupsBasePath(),
      'permanent-deletion-intents',
      `${encodeURIComponent(teamName)}.json`
    );
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'Durable Detach Proof Team' })
    );

    const firstService = new TeamBackupService();
    await firstService.initialize();
    const prepared = await firstService.beginPermanentDeletion(teamName);
    const deleting = await firstService.commitPermanentDeletionBoundary(prepared);
    await firstService.withPermanentDeletionTargetFence(
      deleting,
      async (isTargetCurrent, getTargetProofHooks) => {
        const proofHooks = getTargetProofHooks('team-data');
        await fs.rename(teamDir, proofHooks.detachedPath);
        const detachedStats = await fs.lstat(proofHooks.detachedPath);
        const identity = {
          dev: detachedStats.dev,
          ino: detachedStats.ino,
          birthtimeMs: detachedStats.birthtimeMs,
        };
        await expect(isTargetCurrent('team-data', proofHooks.detachedPath)).resolves.toBe(true);
        await proofHooks.onDetachedValidated(proofHooks.detachedPath, identity);
        await fs.rm(proofHooks.detachedPath, { recursive: true });
        // Simulate process loss after durable directory removal but before the
        // final removed receipt can be persisted.
        return false;
      }
    );
    const detachedOnly = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(detachedOnly).toMatchObject({
      targetRemovalProofs: {
        'team-data': {
          state: 'detached',
          transactionId: deleting.transactionId,
        },
      },
      completedTargets: [],
      cleanupCompleted: false,
    });
    firstService.dispose();

    const recoveredService = new TeamBackupService();
    await recoveredService.initialize();
    const [recovered] = await recoveredService.listPendingPermanentDeletions();
    const reconciled = await recoveredService.reconcilePermanentDeletionProgress(recovered);
    expect(reconciled).toMatchObject({
      transactionId: deleting.transactionId,
      targetRemovalProofs: {
        'team-data': {
          state: 'removed',
          transactionId: deleting.transactionId,
        },
      },
      completedTargets: ['team-data'],
      cleanupCompleted: true,
    });
    await recoveredService.completePermanentDeletion(reconciled);
    await expect(
      fs.readFile(intentPath, 'utf8').then((raw) => JSON.parse(raw) as { phase: string })
    ).resolves.toMatchObject({ phase: 'deleted' });
    recoveredService.dispose();
  });
});
