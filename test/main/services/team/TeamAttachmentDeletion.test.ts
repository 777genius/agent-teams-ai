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

  async function withAdmittedDeletion(
    teamName: string,
    operation: Parameters<TeamBackupService['withPermanentDeletionTargetFence']>[1]
  ): Promise<boolean> {
    const teamDir = path.join(getTeamsBasePath(), teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({ name: teamName }));
    const backupService = new TeamBackupService();
    try {
      await backupService.initialize();
      const prepared = await backupService.beginPermanentDeletion(teamName);
      const deleting = await backupService.commitPermanentDeletionBoundary(prepared);
      return await backupService.withPermanentDeletionTargetFence(deleting, operation);
    } finally {
      backupService.dispose();
    }
  }

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

  it('requires deletion authority before either attachment store mutates a team tree', async () => {
    const messageFile = path.join(getAppDataPath(), 'attachments', 'unadmitted', 'message.json');
    const taskFile = path.join(getAppDataPath(), 'task-attachments', 'unadmitted', 'task.json');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await fs.mkdir(path.dirname(taskFile), { recursive: true });
    await fs.writeFile(messageFile, 'message');
    await fs.writeFile(taskFile, 'task');

    await expect(new TeamAttachmentStore().deleteTeamAttachments('unadmitted'))
      .rejects.toThrow('operator_required: permanent deletion writer admission is unavailable');
    await expect(new TeamTaskAttachmentStore().deleteTeamAttachments('unadmitted'))
      .rejects.toThrow('operator_required: permanent deletion writer admission is unavailable');
    await expect(fs.readFile(messageFile, 'utf8')).resolves.toBe('message');
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('task');
  });

  it('retains the first attachment quarantine and leaves other teams untouched', async () => {
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

    await expect(withAdmittedDeletion('target-team', async (isCurrent, getHooks) => {
      await new TeamAttachmentStore().deleteTeamAttachments(
        'target-team',
        (detachedPath) => isCurrent('message-attachments', detachedPath),
        getHooks('message-attachments')
      );
      return false;
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');

    await expect(
      fs.stat(path.join(appDataPath, 'attachments', 'target-team'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(appDataPath, 'task-attachments', 'target-team'))
    ).resolves.toBeDefined();
    const quarantines = await fs.readdir(path.join(appDataPath, 'attachments'));
    const quarantine = quarantines.find((name) => name.startsWith('.target-team.permanent-deletion.'));
    expect(quarantine).toBeDefined();
    await expect(fs.readFile(path.join(appDataPath, 'attachments', quarantine!, 'message-1', 'attachment--image.png'), 'utf8')).resolves.toBe('message');
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

    await withAdmittedDeletion('replacement-team', async (_isCurrent, getHooks) => {
      expect(await new TeamAttachmentStore().deleteTeamAttachments(
        'replacement-team', async () => false, getHooks('message-attachments')
      )).toBe(false);
      expect(await new TeamTaskAttachmentStore().deleteTeamAttachments(
        'replacement-team', async () => false, getHooks('task-attachments')
      )).toBe(false);
      return false;
    });

    await expect(fs.readFile(messageFile, 'utf8')).resolves.toBe('replacement-message');
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('replacement-task');
  });

  it('preserves a replacement published at the public name during validation', async () => {
    const teamName = 'reservation-replacement-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    const replacementFile = path.join(teamDir, 'replacement-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');

    let replacementPublished = false;
    await expect(withAdmittedDeletion(teamName, async (isCurrent, getHooks) => {
      const removed = await new TeamAttachmentStore().deleteTeamAttachments(teamName, async (detachedPath) => {
        if (detachedPath !== teamDir && !replacementPublished) {
          await fs.mkdir(teamDir);
          await fs.writeFile(replacementFile, 'replacement-message');
          replacementPublished = true;
        }
        return isCurrent('message-attachments', detachedPath);
      }, getHooks('message-attachments'));
      return removed;
    })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');

    expect(replacementPublished).toBe(true);
    await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-message');
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never calls pathname rm for an admitted detached attachment tree', async () => {
    const teamName = 'reservation-cleanup-interleaving-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    const replacementFile = path.join(teamDir, 'replacement-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');

    const realRm = nativeFs.promises.rm.bind(nativeFs.promises);
    let replacementPublished = false;
    let detachedPath = '';
    const rmSpy = vi
      .spyOn(nativeFs.promises, 'rm')
      .mockImplementation(async (candidatePath, options) => {
        if (!replacementPublished && path.resolve(String(candidatePath)) === path.resolve(detachedPath)) {
          await fs.mkdir(teamDir);
          await fs.writeFile(replacementFile, 'replacement-message');
          replacementPublished = true;
        }
        return realRm(candidatePath, options);
      });

    try {
      await expect(withAdmittedDeletion(teamName, async (isCurrent, getHooks) => {
        const proof = getHooks('message-attachments');
        detachedPath = proof.detachedPath;
        return new TeamAttachmentStore().deleteTeamAttachments(
          teamName,
          (candidate) => isCurrent('message-attachments', candidate),
          proof
        );
      })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
      expect(replacementPublished).toBe(false);
      expect(rmSpy).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(detachedPath, 'old-message.json'), 'utf8')).resolves.toBe('old-message');
      await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('preserves replacements and aborts remaining cleanup when a new source generation appears', async () => {
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

    const realRename = nativeFs.promises.rename.bind(nativeFs.promises);
    const renameSpy = vi
      .spyOn(nativeFs.promises, 'rename')
      .mockImplementation(async (sourcePath, destinationPath) => {
        await realRename(sourcePath, destinationPath);
        if (path.resolve(String(sourcePath)) !== path.resolve(teamDir)) return;

        for (const [filePath, content] of [
          [
            replacementConfig,
            JSON.stringify({
              name: 'Replacement Team',
              _backupIdentityId: 'replacement-team-identity',
            }),
          ],
          [replacementTask, '{"subject":"replacement"}'],
          [replacementMessage, 'replacement-message'],
          [replacementTaskAttachment, 'replacement-task-attachment'],
        ]) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content);
        }
      });

    try {
      const dataService = new TeamDataService();
      await expect(
        backupService.withPermanentDeletionTargetFence(deleting, async (isTargetCurrent, getTargetProofHooks) => {
          if (
            !(await dataService.permanentlyDeleteTeam(
              teamName,
              (detachedPath) => isTargetCurrent('team-data', detachedPath),
              (detachedPath) => isTargetCurrent('task-data', detachedPath),
              {
                teamDataProofHooks: getTargetProofHooks('team-data'),
                taskDataProofHooks: getTargetProofHooks('task-data'),
              }
            ))
          ) {
            return false;
          }
          if (
            !(await new TeamAttachmentStore().deleteTeamAttachments(teamName, (detachedPath) =>
              isTargetCurrent('message-attachments', detachedPath),
              getTargetProofHooks('message-attachments')
            ))
          ) {
            return false;
          }
          return new TeamTaskAttachmentStore().deleteTeamAttachments(teamName, (detachedPath) =>
            isTargetCurrent('task-attachments', detachedPath),
            getTargetProofHooks('task-attachments')
          );
        })
      ).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');

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

  it('retains incomplete receipts and untouched attachment roots across restart', async () => {
    const teamName = 'restart-cleanup-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const taskDir = path.join(getTasksBasePath(), teamName);
    const messageDir = path.join(getAppDataPath(), 'attachments', teamName);
    const taskAttachmentDir = path.join(getAppDataPath(), 'task-attachments', teamName);
    await Promise.all([teamDir, taskDir, messageDir, taskAttachmentDir].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    ));
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({ name: teamName }));
    await fs.writeFile(path.join(teamDir, 'a.json'), 'A');
    await fs.writeFile(path.join(taskDir, 'task.json'), 'task');
    await fs.writeFile(path.join(messageDir, 'message.json'), 'message');
    await fs.writeFile(path.join(taskAttachmentDir, 'attachment.txt'), 'attachment');
    const owner = new TeamBackupService();
    await owner.initialize();
    const prepared = await owner.beginPermanentDeletion(teamName);
    const deleting = await owner.commitPermanentDeletionBoundary(prepared);
    await expect(owner.withPermanentDeletionTargetFence(deleting, (isCurrent, getHooks) =>
      new TeamDataService().permanentlyDeleteTeam(teamName,
        (detachedPath) => isCurrent('team-data', detachedPath),
        (detachedPath) => isCurrent('task-data', detachedPath),
        { teamDataProofHooks: getHooks('team-data'), taskDataProofHooks: getHooks('task-data') }
      )
    )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    const quarantine = path.join(getTeamsBasePath(),
      `.${teamName}.permanent-deletion.${deleting.transactionId}.team-data`
    );
    await expect(fs.readFile(path.join(quarantine, 'a.json'), 'utf8')).resolves.toBe('A');
    await expect(fs.readFile(path.join(taskDir, 'task.json'), 'utf8')).resolves.toBe('task');
    await expect(fs.readFile(path.join(messageDir, 'message.json'), 'utf8')).resolves.toBe('message');
    await expect(fs.readFile(path.join(taskAttachmentDir, 'attachment.txt'), 'utf8'))
      .resolves.toBe('attachment');
    owner.dispose();
    const recovered = new TeamBackupService();
    await recovered.initialize();
    try {
      const [pending] = await recovered.listPendingPermanentDeletions();
      expect(pending?.targetRemovalProofs['team-data']?.state).toBe('detached');
      expect(pending?.cleanupCompleted).toBe(false);
      await expect(recovered.completePermanentDeletion(pending!))
        .rejects.toThrow('Permanent deletion cleanup is incomplete');
    } finally {
      recovered.dispose();
    }
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
          const originalStats = await fs.lstat(teamDir);
          await proofHooks.onRemovalPrepared?.(teamDir, {
            dev: originalStats.dev,
            ino: originalStats.ino,
            birthtimeMs: originalStats.birthtimeMs,
          });
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
        targetRemovalProofs: { 'team-data': { state: persistDetachedProof ? 'detached' : 'authorized' } },
      });
      await expect(recoveredService.isPermanentDeletionTargetCurrent(recovered)).resolves.toBe(
        true
      );

      const dataService = new TeamDataService();
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

      const rmSpy = vi.spyOn(nativeFs.promises, 'rm');
      try {
        await expect(resumeExactDeletion()).rejects.toThrow(
          'operator_required: identity-bound quarantine removal is unavailable'
        );
        await expect(resumeExactDeletion()).rejects.toThrow(
          'operator_required: identity-bound quarantine removal is unavailable'
        );
        expect(rmSpy).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(detachedPath, 'nested', 'original.txt'), 'utf8'))
          .resolves.toBe('transaction-owned-original');
        await expect(fs.readFile(unrelatedFile, 'utf8')).resolves.toBe('unrelated-sibling');
        if (publishReplacement) {
          await expect(fs.readFile(replacementFile, 'utf8')).resolves.toBe('replacement-survives');
        } else {
          await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        rmSpy.mockRestore();
      }
      const retainedIntent = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
        targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
        completedTargets: string[];
        cleanupCompleted: boolean;
      };
      expect(retainedIntent.targetRemovalProofs['team-data']).toMatchObject({
        state: 'detached', transactionId: deleting.transactionId,
      });
      expect(retainedIntent.completedTargets).toEqual([]);
      expect(retainedIntent.cleanupCompleted).toBe(false);
      await expect(recoveredService.completePermanentDeletion(recovered))
        .rejects.toThrow('Permanent deletion cleanup is incomplete');
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

    const dataService = new TeamDataService();

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
            { skipTaskData: true, teamDataProofHooks: getTargetProofHooks('team-data') }
          );
        }
      )
    ).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    await expect(fs.stat(teamDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const retained = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(retained.targetRemovalProofs['team-data']).toMatchObject({
      state: 'detached', transactionId: deleting.transactionId,
    });
    expect(retained.completedTargets).toEqual([]);
    expect(retained.cleanupCompleted).toBe(false);
    await expect(recoveredService.completePermanentDeletion(recovered))
      .rejects.toThrow('Permanent deletion cleanup is incomplete');
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
        const originalStats = await fs.lstat(teamDir);
        await proofHooks.onRemovalPrepared?.(teamDir, {
          dev: originalStats.dev,
          ino: originalStats.ino,
          birthtimeMs: originalStats.birthtimeMs,
        });
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
    await expect(recoveredService.reconcilePermanentDeletionProgress(recovered)).rejects.toThrow(
      'operator_required: permanent deletion receipt is missing'
    );
    await expect(recoveredService.completePermanentDeletion(recovered)).rejects.toThrow();
    await expect(
      fs.readFile(intentPath, 'utf8').then((raw) => JSON.parse(raw) as { phase: string })
    ).resolves.toMatchObject({ phase: 'deleting' });
    recoveredService.dispose();
  });
});
