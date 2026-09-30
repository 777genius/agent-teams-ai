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

  it('keeps attachment roots public when removal capability is unavailable', async () => {
    const appDataPath = getAppDataPath();
    const messageFile = path.join(appDataPath, 'attachments', 'target-team', 'message.json');
    const taskFile = path.join(appDataPath, 'task-attachments', 'target-team', 'task.json');
    const siblingFile = path.join(appDataPath, 'attachments', 'sibling-team', 'message.json');
    for (const [file, content] of [[messageFile, 'message'], [taskFile, 'task'], [siblingFile, 'sibling']]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    await expect(withAdmittedDeletion('target-team', (isCurrent, getHooks) =>
      new TeamAttachmentStore().deleteTeamAttachments(
        'target-team',
        (detachedPath) => isCurrent('message-attachments', detachedPath),
        getHooks('message-attachments')
      )
    )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    await expect(fs.readFile(messageFile, 'utf8')).resolves.toBe('message');
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('task');
    await expect(fs.readFile(siblingFile, 'utf8')).resolves.toBe('sibling');
    expect((await fs.readdir(path.dirname(path.dirname(messageFile))))
      .filter((name) => name.startsWith('.target-team.permanent-deletion.'))).toEqual([]);
  });

  it('rejects removal before invoking a detached-path validator', async () => {
    const teamName = 'validator-team';
    const messageFile = path.join(getAppDataPath(), 'attachments', teamName, 'message.json');
    const taskFile = path.join(getAppDataPath(), 'task-attachments', teamName, 'task.json');
    for (const file of [messageFile, taskFile]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'original');
    }
    const validate = vi.fn(async () => false);
    await withAdmittedDeletion(teamName, async (_isCurrent, getHooks) => {
      await expect(new TeamAttachmentStore().deleteTeamAttachments(
        teamName, validate, getHooks('message-attachments')
      )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
      await expect(new TeamTaskAttachmentStore().deleteTeamAttachments(
        teamName, validate, getHooks('task-attachments')
      )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
      return false;
    });
    expect(validate).not.toHaveBeenCalled();
    await expect(fs.readFile(messageFile, 'utf8')).resolves.toBe('original');
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('original');
  });

  it('does not publish a replacement through a detached validation callback', async () => {
    const teamName = 'reservation-replacement-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');
    const validate = vi.fn(async () => true);
    await expect(withAdmittedDeletion(teamName, (_isCurrent, getHooks) =>
      new TeamAttachmentStore().deleteTeamAttachments(
        teamName, validate, getHooks('message-attachments')
      )
    )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
    expect(validate).not.toHaveBeenCalled();
    await expect(fs.readFile(oldFile, 'utf8')).resolves.toBe('old-message');
  });

  it('never calls pathname rm or rename for an admitted attachment tree', async () => {
    const teamName = 'reservation-cleanup-interleaving-team';
    const teamDir = path.join(getAppDataPath(), 'attachments', teamName);
    const oldFile = path.join(teamDir, 'old-message.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(oldFile, 'old-message');
    const rmSpy = vi.spyOn(nativeFs.promises, 'rm');
    const renameSpy = vi.spyOn(nativeFs.promises, 'rename');
    let detachedPath = '';
    try {
      await expect(withAdmittedDeletion(teamName, (isCurrent, getHooks) => {
        const proof = getHooks('message-attachments');
        detachedPath = proof.detachedPath;
        return new TeamAttachmentStore().deleteTeamAttachments(
          teamName,
          (candidate) => isCurrent('message-attachments', candidate),
          proof
        );
      })).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
      expect(rmSpy).not.toHaveBeenCalled();
      expect(renameSpy.mock.calls.some(([source]) => path.resolve(String(source)) === path.resolve(teamDir))).toBe(false);
      await expect(fs.readFile(oldFile, 'utf8')).resolves.toBe('old-message');
      await expect(fs.stat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rmSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('leaves every target public and pending when ordinary team deletion fails closed', async () => {
    const teamName = 'replacement-race-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const roots = [
      [teamDir, 'config.json', JSON.stringify({ name: 'Old Team' })],
      [path.join(getTasksBasePath(), teamName), 'task.json', 'task'],
      [path.join(getAppDataPath(), 'attachments', teamName), 'message.json', 'message'],
      [path.join(getAppDataPath(), 'task-attachments', teamName), 'attachment.txt', 'attachment'],
    ] as const;
    for (const [root, name, content] of roots) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    const backupService = new TeamBackupService();
    await backupService.initialize();
    try {
      const prepared = await backupService.beginPermanentDeletion(teamName);
      const deleting = await backupService.commitPermanentDeletionBoundary(prepared);
      const renameSpy = vi.spyOn(nativeFs.promises, 'rename');
      try {
        await expect(backupService.withPermanentDeletionTargetFence(deleting, (isCurrent, getHooks) =>
          new TeamDataService().permanentlyDeleteTeam(
            teamName,
            (detachedPath) => isCurrent('team-data', detachedPath),
            (detachedPath) => isCurrent('task-data', detachedPath),
            { teamDataProofHooks: getHooks('team-data'), taskDataProofHooks: getHooks('task-data') }
          )
        )).rejects.toThrow('operator_required: identity-bound quarantine removal is unavailable');
        expect(renameSpy.mock.calls.some(([source]) => path.resolve(String(source)) === path.resolve(teamDir))).toBe(false);
      } finally {
        renameSpy.mockRestore();
      }
      for (const [root, name, content] of roots) {
        const actual = await fs.readFile(path.join(root, name), 'utf8');
        if (name === 'config.json') {
          expect(JSON.parse(actual)).toMatchObject({ name: 'Old Team' });
        } else {
          expect(actual).toBe(content);
        }
      }
      const [pending] = await backupService.listPendingPermanentDeletions();
      expect(pending).toMatchObject({ phase: 'deleting', cleanupCompleted: false, targetRemovalProofs: {} });
    } finally {
      backupService.dispose();
    }
  });

  it('reports a pending deletion after restart without creating quarantine receipts', async () => {
    const teamName = 'restart-cleanup-team';
    const teamDir = path.join(getTeamsBasePath(), teamName);
    const taskDir = path.join(getTasksBasePath(), teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({ name: teamName }));
    await fs.writeFile(path.join(taskDir, 'task.json'), 'task');
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
    owner.dispose();
    const recovered = new TeamBackupService();
    await recovered.initialize();
    try {
      const [pending] = await recovered.listPendingPermanentDeletions();
      expect(pending).toMatchObject({ phase: 'deleting', targetRemovalProofs: {}, cleanupCompleted: false });
      await expect(fs.readFile(path.join(teamDir, 'config.json'), 'utf8')).resolves.toContain(teamName);
      await expect(fs.readFile(path.join(taskDir, 'task.json'), 'utf8')).resolves.toBe('task');
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
    await expect(fs.readFile(originalFile, 'utf8')).resolves.toBe('exact-original-tree');
    const retained = JSON.parse(await fs.readFile(intentPath, 'utf8')) as {
      targetRemovalProofs: Record<string, { state: string; transactionId: string }>;
      completedTargets: string[];
      cleanupCompleted: boolean;
    };
    expect(retained.targetRemovalProofs).toEqual({});
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
