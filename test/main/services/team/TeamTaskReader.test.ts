import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamTask } from '../../../../src/shared/types/team';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTask(id: string): TeamTask & { teamName: string } {
  return {
    id,
    subject: id,
    owner: 'alice',
    status: 'pending',
    createdAt: '2026-05-02T12:00:00.000Z',
    updatedAt: '2026-05-02T12:00:00.000Z',
    teamName: 'atlas-hq',
  };
}

describe('TeamTaskReader', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    TeamTaskReader.invalidateAllTasksCache();
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function setupTasksRoot(): Promise<string> {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'team-task-reader-'));
    setClaudeBasePathOverride(tmpDir);
    await fsp.mkdir(path.join(tmpDir, 'tasks'), { recursive: true });
    return tmpDir;
  }

  async function writeTaskFile(teamName: string, task: Record<string, unknown>): Promise<string> {
    const tasksDir = path.join(tmpDir!, 'tasks', teamName);
    await fsp.mkdir(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, `${String(task.id)}.json`);
    await fsp.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8');
    return taskPath;
  }

  it('does not reuse or cache a stale in-flight getAllTasks scan after invalidation', async () => {
    const firstRead = createDeferred<(TeamTask & { teamName: string })[]>();
    const secondRead = createDeferred<(TeamTask & { teamName: string })[]>();
    const readAllTasksUncached = vi
      .spyOn(
        TeamTaskReader.prototype as unknown as {
          readAllTasksUncached: () => Promise<(TeamTask & { teamName: string })[]>;
        },
        'readAllTasksUncached'
      )
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);

    const reader = new TeamTaskReader();
    const staleRequest = reader.getAllTasks();
    await Promise.resolve();
    expect(readAllTasksUncached).toHaveBeenCalledTimes(1);

    TeamTaskReader.invalidateAllTasksCache();
    const freshRequest = reader.getAllTasks();
    await Promise.resolve();
    expect(readAllTasksUncached).toHaveBeenCalledTimes(2);

    secondRead.resolve([makeTask('fresh-task')]);
    await expect(freshRequest).resolves.toEqual([makeTask('fresh-task')]);

    firstRead.resolve([makeTask('stale-task')]);
    await staleRequest;

    await expect(reader.getAllTasks()).resolves.toEqual([makeTask('fresh-task')]);
    expect(readAllTasksUncached).toHaveBeenCalledTimes(2);
  });

  it('reuses parsed task files until their file signature changes', async () => {
    await setupTasksRoot();
    await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Cached task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
    });

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const reader = new TeamTaskReader();

    const firstRead = await reader.getTasks('atlas-hq');
    expect(firstRead).toMatchObject([{ id: '1', subject: 'Cached task' }]);
    firstRead[0]!.subject = 'Mutated caller copy';
    await expect(reader.getTasks('atlas-hq')).resolves.toMatchObject([
      { id: '1', subject: 'Cached task' },
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(1);

    await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Changed cached task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
    });

    await expect(reader.getTasks('atlas-hq')).resolves.toMatchObject([
      { id: '1', subject: 'Changed cached task' },
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });
});
