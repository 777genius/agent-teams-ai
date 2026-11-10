import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeTaskLogAttributionService,
  type OpenCodeTaskLogAttributionWriter,
} from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionService';
import type { OpenCodeTaskLogAttributionWriteResult } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore';

function createWriter(result: OpenCodeTaskLogAttributionWriteResult = 'created') {
  const writer: OpenCodeTaskLogAttributionWriter = {
    upsertTaskRecord: vi.fn<OpenCodeTaskLogAttributionWriter['upsertTaskRecord']>(
      async () => result
    ),
    replaceTaskRecords: vi.fn<OpenCodeTaskLogAttributionWriter['replaceTaskRecords']>(
      async () => result
    ),
    clearTaskRecords: vi.fn<OpenCodeTaskLogAttributionWriter['clearTaskRecords']>(
      async () => result
    ),
  };
  return writer;
}

describe('OpenCodeTaskLogAttributionService', () => {
  it('records task-session attribution through the writer with launch defaults', async () => {
    const writer = createWriter('created');
    const now = new Date('2026-04-21T12:00:00.000Z');
    const service = new OpenCodeTaskLogAttributionService(writer, () => now);

    const outcome = await service.recordTaskSession({
      teamName: ' team-a ',
      taskId: ' task-a ',
      memberName: ' alice ',
      sessionId: ' session-a ',
      since: new Date('2026-04-21T11:59:00.000Z'),
    });

    const expectedRecord = {
      taskId: 'task-a',
      memberName: 'alice',
      scope: 'task_session' as const,
      sessionId: 'session-a',
      since: '2026-04-21T11:59:00.000Z',
      source: 'launch_runtime' as const,
    };
    expect(outcome).toEqual({ result: 'created', record: expectedRecord });
    expect(writer.upsertTaskRecord).toHaveBeenCalledWith('team-a', expectedRecord, { now });
    expect(writer.replaceTaskRecords).not.toHaveBeenCalled();
  });

  it('rejects task-session attribution without a session id before writing', async () => {
    const writer = createWriter();
    const service = new OpenCodeTaskLogAttributionService(writer);

    await expect(
      service.recordTaskSession({
        teamName: 'team-a',
        taskId: 'task-a',
        memberName: 'alice',
        sessionId: ' ',
      })
    ).rejects.toThrow('task_session requires sessionId');
    expect(writer.upsertTaskRecord).not.toHaveBeenCalled();
  });

  it('rejects unsafe team, task, and member identifiers before writing', async () => {
    const writer = createWriter();
    const service = new OpenCodeTaskLogAttributionService(writer);

    await expect(
      service.recordTaskSession({
        teamName: '../team-a',
        taskId: 'task-a',
        memberName: 'alice',
        sessionId: 'session-a',
      })
    ).rejects.toThrow('teamName contains invalid characters');

    await expect(
      service.recordTaskSession({
        teamName: 'team-a',
        taskId: '../task-a',
        memberName: 'alice',
        sessionId: 'session-a',
      })
    ).rejects.toThrow('taskId contains invalid characters');

    await expect(
      service.recordTaskSession({
        teamName: 'team-a',
        taskId: 'task-a',
        memberName: '../alice',
        sessionId: 'session-a',
      })
    ).rejects.toThrow('memberName contains invalid characters');
    expect(writer.upsertTaskRecord).not.toHaveBeenCalled();
  });

  it('rejects broad or invalid member-window attribution before writing', async () => {
    const writer = createWriter();
    const service = new OpenCodeTaskLogAttributionService(writer);

    await expect(
      service.recordMemberSessionWindow({
        teamName: 'team-a',
        taskId: 'task-a',
        memberName: 'alice',
        sessionId: 'session-a',
      })
    ).rejects.toThrow('requires since or startMessageUuid');

    await expect(
      service.recordMemberSessionWindow({
        teamName: 'team-a',
        taskId: 'task-a',
        memberName: 'alice',
        until: '2026-04-21T12:00:00.000Z',
      })
    ).rejects.toThrow('requires since or startMessageUuid');

    await expect(
      service.recordMemberSessionWindow({
        teamName: 'team-a',
        taskId: 'task-a',
        memberName: 'alice',
        since: '2026-04-21T13:00:00.000Z',
        until: '2026-04-21T12:00:00.000Z',
      })
    ).rejects.toThrow('since must be before or equal to until');
    expect(writer.upsertTaskRecord).not.toHaveBeenCalled();
  });

  it('records bounded member-window attribution through the writer with reconcile defaults', async () => {
    const writer = createWriter('updated');
    const now = new Date('2026-04-21T12:00:00.000Z');
    const service = new OpenCodeTaskLogAttributionService(writer, () => now);

    const outcome = await service.recordMemberSessionWindow({
      teamName: 'team-a',
      taskId: 'task-a',
      memberName: 'bob',
      sessionId: 'session-b',
      startMessageUuid: ' m-1 ',
      endMessageUuid: ' m-3 ',
    });

    const expectedRecord = {
      taskId: 'task-a',
      memberName: 'bob',
      scope: 'member_session_window' as const,
      sessionId: 'session-b',
      startMessageUuid: 'm-1',
      endMessageUuid: 'm-3',
      source: 'reconcile' as const,
    };
    expect(outcome).toEqual({ result: 'updated', record: expectedRecord });
    expect(writer.upsertTaskRecord).toHaveBeenCalledWith('team-a', expectedRecord, { now });
  });

  it('replaces task attribution as a validated runtime snapshot', async () => {
    const writer = createWriter('updated');
    const now = new Date('2026-04-21T12:00:00.000Z');
    const service = new OpenCodeTaskLogAttributionService(writer, () => now);

    const outcome = await service.replaceTaskAttribution({
      teamName: 'team-a',
      taskId: 'task-a',
      source: 'reconcile',
      records: [
        {
          memberName: 'alice',
          scope: 'task_session',
          sessionId: 'session-a',
          source: 'launch_runtime',
        },
        {
          memberName: 'bob',
          since: '2026-04-21T11:00:00Z',
          until: new Date('2026-04-21T11:30:00.000Z'),
        },
      ],
    });

    expect(outcome).toEqual({ result: 'updated', recordCount: 2 });
    expect(writer.replaceTaskRecords).toHaveBeenCalledWith(
      'team-a',
      'task-a',
      [
        {
          taskId: 'task-a',
          memberName: 'alice',
          scope: 'task_session',
          sessionId: 'session-a',
          source: 'launch_runtime',
        },
        {
          taskId: 'task-a',
          memberName: 'bob',
          scope: 'member_session_window',
          since: '2026-04-21T11:00:00.000Z',
          until: '2026-04-21T11:30:00.000Z',
          source: 'reconcile',
        },
      ],
      { now }
    );
  });

  it('clears task attribution through the writer only for one task', async () => {
    const writer = createWriter('deleted');
    const service = new OpenCodeTaskLogAttributionService(writer);

    await expect(
      service.clearTaskAttribution({ teamName: ' team-a ', taskId: ' task-a ' })
    ).resolves.toEqual({ result: 'deleted', recordCount: 0 });
    expect(writer.clearTaskRecords).toHaveBeenCalledWith('team-a', 'task-a');
    expect(writer.upsertTaskRecord).not.toHaveBeenCalled();
  });
});
