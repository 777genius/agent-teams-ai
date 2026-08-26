import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSystemCreateArtifactTransaction } from '../TeamProvisioningCreateArtifactTransaction';

const tempRoots: string[] = [];

async function createFixture(options: { config?: string; tasks?: boolean } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'create-artifact-transaction-'));
  tempRoots.push(root);
  const teamDir = path.join(root, 'teams', 'draft-team');
  const tasksDir = path.join(root, 'tasks', 'draft-team');
  await fs.promises.mkdir(teamDir, { recursive: true });
  const draftMeta = '{"version":1,"cwd":"/draft","createdAt":1}\n';
  const draftMembers = '{"version":1,"members":[{"name":"alice"}]}\n';
  await fs.promises.writeFile(path.join(teamDir, 'team.meta.json'), draftMeta);
  await fs.promises.writeFile(path.join(teamDir, 'members.meta.json'), draftMembers);
  if (options.config !== undefined) {
    await fs.promises.writeFile(path.join(teamDir, 'config.json'), options.config);
  }
  if (options.tasks) {
    await fs.promises.mkdir(tasksDir, { recursive: true });
    await fs.promises.writeFile(path.join(tasksDir, 'task-1.json'), '{"subject":"saved"}\n');
  }
  return { root, teamDir, tasksDir, draftMeta, draftMembers };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

describe('FileSystemCreateArtifactTransaction', () => {
  it('restores exact draft metadata/config state and preserves preexisting tasks', async () => {
    const fixture = await createFixture({ tasks: true });
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'attempt-a',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });

    await transaction.ensureDirectory(fixture.teamDir);
    await transaction.ensureDirectory(fixture.tasksDir);
    await fs.promises.writeFile(path.join(fixture.teamDir, 'team.meta.json'), 'attempt-meta');
    await transaction.recordFileWrite('team-meta');
    await fs.promises.writeFile(path.join(fixture.teamDir, 'config.json'), 'attempt-config');
    await transaction.recordFileWrite('config');

    await expect(transaction.rollbackIfOwned()).resolves.toEqual({
      status: 'rolled-back',
      retained: [],
      errors: [],
    });
    await expect(
      fs.promises.readFile(path.join(fixture.teamDir, 'team.meta.json'), 'utf8')
    ).resolves.toBe(fixture.draftMeta);
    await expect(
      fs.promises.access(path.join(fixture.teamDir, 'config.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.promises.readFile(path.join(fixture.tasksDir, 'task-1.json'), 'utf8')
    ).resolves.toBe('{"subject":"saved"}\n');
    await expect(
      fs.promises.readFile(path.join(fixture.teamDir, 'members.meta.json'), 'utf8')
    ).resolves.toBe(fixture.draftMembers);
  });

  it('restores exact prior config content when the attempt replaced it', async () => {
    const priorConfig = '{"name":"preexisting-evidence"}\n';
    const fixture = await createFixture({ config: priorConfig });
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'attempt-config',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });
    await transaction.ensureDirectory(fixture.tasksDir);
    await fs.promises.writeFile(path.join(fixture.teamDir, 'config.json'), 'attempt-config');
    await transaction.recordFileWrite('config');

    await transaction.rollbackIfOwned();

    await expect(
      fs.promises.readFile(path.join(fixture.teamDir, 'config.json'), 'utf8')
    ).resolves.toBe(priorConfig);
  });

  it('retains a concurrent newer draft edit on compare-and-swap mismatch', async () => {
    const fixture = await createFixture();
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'old-attempt',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });
    await fs.promises.writeFile(path.join(fixture.teamDir, 'team.meta.json'), 'old-attempt-meta');
    await transaction.recordFileWrite('team-meta');
    await fs.promises.writeFile(path.join(fixture.teamDir, 'team.meta.json'), 'newer-draft-edit');

    await expect(transaction.rollbackIfOwned()).resolves.toMatchObject({
      status: 'retained',
      retained: ['team-meta'],
    });
    await expect(
      fs.promises.readFile(path.join(fixture.teamDir, 'team.meta.json'), 'utf8')
    ).resolves.toBe('newer-draft-edit');
  });

  it('does not delete a newer config that replaced the attempt-owned file', async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.teamDir, 'config.json');
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'old-config-attempt',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });
    await fs.promises.writeFile(configPath, 'old-attempt-config');
    await transaction.recordFileWrite('config');
    await fs.promises.writeFile(configPath, 'newer-config-evidence');

    await expect(transaction.rollbackIfOwned()).resolves.toMatchObject({
      status: 'retained',
      retained: ['config'],
    });
    await expect(fs.promises.readFile(configPath, 'utf8')).resolves.toBe(
      'newer-config-evidence'
    );
  });

  it('restores a newer config that wins during the atomic delete fence', async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.teamDir, 'config.json');
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'delete-race-attempt',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });
    await fs.promises.writeFile(configPath, 'attempt-owned-config');
    await transaction.recordFileWrite('config');
    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementationOnce(async (from: fs.PathLike, to: fs.PathLike) => {
        await fs.promises.writeFile(configPath, 'newer-config-during-delete');
        await rename(from, to);
      });

    try {
      await expect(transaction.rollbackIfOwned()).resolves.toMatchObject({
        status: 'retained',
        retained: ['config'],
      });
      await expect(fs.promises.readFile(configPath, 'utf8')).resolves.toBe(
        'newer-config-during-delete'
      );
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('never recursively removes task evidence created by the attempt', async () => {
    const fixture = await createFixture();
    const transaction = await FileSystemCreateArtifactTransaction.begin({
      attemptId: 'attempt-with-task-evidence',
      teamName: 'draft-team',
      teamDir: fixture.teamDir,
      tasksDir: fixture.tasksDir,
    });
    await transaction.ensureDirectory(fixture.tasksDir);
    await fs.promises.writeFile(path.join(fixture.tasksDir, 'task-created.json'), 'evidence');

    await expect(transaction.rollbackIfOwned()).resolves.toMatchObject({
      status: 'retained',
      retained: ['draft-team'],
    });
    await expect(
      fs.promises.readFile(path.join(fixture.tasksDir, 'task-created.json'), 'utf8')
    ).resolves.toBe('evidence');
  });
});
