import { describe, expect, it, vi } from 'vitest';

import { BoardTaskActivityRecordSource } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecordSource';

describe('BoardTaskActivityRecordSource', () => {
  it('uses active and deleted tasks together when building explicit task records', async () => {
    const targetTask = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'A',
      status: 'pending',
    };
    const deletedTask = {
      id: 'task-b',
      displayId: 'deadbeef',
      subject: 'B',
      status: 'deleted',
    };
    const transcriptFiles = ['/tmp/a.jsonl'];
    const rawMessages = [{ uuid: 'm1' }];
    const builtRecords = [{ id: 'r1' }];

    const locator = {
      listTranscriptFiles: vi.fn(async () => transcriptFiles),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [targetTask]),
      getDeletedTasks: vi.fn(async () => [deletedTask]),
    };
    const transcriptReader = {
      readFiles: vi.fn(async () => rawMessages),
    };
    const recordBuilder = {
      buildForTasks: vi.fn(() => new Map([['task-a', builtRecords]])),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    const result = await source.getTaskRecords('demo', 'task-a');

    expect(result).toEqual(builtRecords);
    expect(result).not.toBe(builtRecords);
    expect(locator.listTranscriptFiles).toHaveBeenCalledWith('demo');
    expect(transcriptReader.readFiles).toHaveBeenCalledWith(transcriptFiles);
    expect(recordBuilder.buildForTasks).toHaveBeenCalledWith({
      teamName: 'demo',
      tasks: [targetTask, deletedTask],
      messages: rawMessages,
    });
  });

  it('returns empty when the target task is unknown', async () => {
    const locator = {
      listTranscriptFiles: vi.fn(async () => ['/tmp/a.jsonl']),
    };
    const taskReader = {
      getTasks: vi.fn(async () => []),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptReader = {
      readFiles: vi.fn(async () => [{ uuid: 'm1' }]),
    };
    const recordBuilder = {
      buildForTasks: vi.fn(() => new Map([['task-known', [{ id: 'r1' }]]])),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    await expect(source.getTaskRecords('demo', 'task-missing')).resolves.toEqual([]);
    expect(recordBuilder.buildForTasks).not.toHaveBeenCalled();
  });

  it('shares one in-flight team index across concurrent task lookups', async () => {
    const taskA = {
      id: 'task-a',
      displayId: 'aaaa1111',
      subject: 'A',
      status: 'pending',
    };
    const taskB = {
      id: 'task-b',
      displayId: 'bbbb2222',
      subject: 'B',
      status: 'pending',
    };
    const transcriptFiles = ['/tmp/a.jsonl'];
    const rawMessages = [{ uuid: 'm1' }];
    const recordsA = [{ id: 'record-a' }];
    const recordsB = [{ id: 'record-b' }];

    let resolveReadFiles: (messages: typeof rawMessages) => void = () => undefined;
    const readFilesPromise = new Promise<typeof rawMessages>((resolve) => {
      resolveReadFiles = resolve;
    });
    const locator = {
      listTranscriptFiles: vi.fn(async () => transcriptFiles),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [taskA, taskB]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptReader = {
      readFiles: vi.fn(() => readFilesPromise),
    };
    const recordBuilder = {
      buildForTasks: vi.fn(() => new Map([
        ['task-a', recordsA],
        ['task-b', recordsB],
      ])),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    const taskAResult = source.getTaskRecords('demo', 'task-a');
    const taskBResult = source.getTaskRecords('demo', 'task-b');
    resolveReadFiles(rawMessages);

    await expect(taskAResult).resolves.toEqual(recordsA);
    await expect(taskBResult).resolves.toEqual(recordsB);
    expect(locator.listTranscriptFiles).toHaveBeenCalledTimes(1);
    expect(transcriptReader.readFiles).toHaveBeenCalledTimes(1);
    expect(recordBuilder.buildForTasks).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the team index when transcript discovery generation changes', async () => {
    const task = {
      id: 'task-a',
      displayId: 'aaaa1111',
      subject: 'A',
      status: 'pending',
    };
    let generation = 0;
    const transcriptFiles = ['/tmp/a.jsonl'];
    const firstRecords = [{ id: 'record-a-1' }];
    const secondRecords = [{ id: 'record-a-2' }];

    const locator = {
      getGeneration: vi.fn(() => generation),
      getContext: vi.fn(async () => ({
        transcriptFiles,
      })),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [task]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptReader = {
      readFiles: vi.fn(async () => [{ uuid: `m${generation}` }]),
    };
    const recordBuilder = {
      buildForTasks: vi
        .fn()
        .mockReturnValueOnce(new Map([['task-a', firstRecords]]))
        .mockReturnValueOnce(new Map([['task-a', secondRecords]])),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    await expect(source.getTaskRecords('demo', 'task-a')).resolves.toEqual(firstRecords);
    generation += 1;
    await expect(source.getTaskRecords('demo', 'task-a')).resolves.toEqual(secondRecords);

    expect(locator.getContext).toHaveBeenCalledTimes(2);
    expect(transcriptReader.readFiles).toHaveBeenCalledTimes(2);
    expect(recordBuilder.buildForTasks).toHaveBeenCalledTimes(2);
  });
});
