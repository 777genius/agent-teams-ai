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
      buildForTask: vi.fn(() => builtRecords),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    const result = await source.getTaskRecords('demo', 'task-a');

    expect(result).toBe(builtRecords);
    expect(locator.listTranscriptFiles).toHaveBeenCalledWith('demo');
    expect(transcriptReader.readFiles).toHaveBeenCalledWith(transcriptFiles);
    expect(recordBuilder.buildForTask).toHaveBeenCalledWith({
      teamName: 'demo',
      targetTask,
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
      buildForTask: vi.fn(() => [{ id: 'r1' }]),
    };

    const source = new BoardTaskActivityRecordSource(
      locator as never,
      taskReader as never,
      transcriptReader as never,
      recordBuilder as never,
    );

    await expect(source.getTaskRecords('demo', 'task-missing')).resolves.toEqual([]);
    expect(recordBuilder.buildForTask).not.toHaveBeenCalled();
  });
});
