import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  let overrideVerifyRead: string | null = null;
  let readCount = 0;

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    readCount += 1;
    if (overrideVerifyRead && readCount >= 2) {
      return overrideVerifyRead;
    }

    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    files.set(norm(filePath), data);
  });

  return {
    files,
    readFile,
    atomicWrite,
    setVerifyOverride: (value: string | null) => {
      overrideVerifyRead = value;
    },
    resetReadCount: () => {
      readCount = 0;
    },
  };
});

vi.mock('fs', () => ({
  promises: {
    readFile: hoisted.readFile,
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
  constants: { F_OK: 0 },
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTasksBasePath: () => '/mock/tasks',
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

import { TeamTaskWriter } from '../../../../src/main/services/team/TeamTaskWriter';

describe('TeamTaskWriter', () => {
  const writer = new TeamTaskWriter();
  const taskPath = '/mock/tasks/my-team/12.json';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.setVerifyOverride(null);
    hoisted.resetReadCount();
  });

  it('createTask writes CLI-compatible format with description, blocks, blockedBy', async () => {
    await writer.createTask('my-team', {
      id: '5',
      subject: 'Test task',
      owner: 'bob',
      status: 'pending',
    });

    const writtenPath = '/mock/tasks/my-team/5.json';
    const persisted = JSON.parse(hoisted.files.get(writtenPath) ?? '{}') as Record<string, unknown>;
    expect(persisted.id).toBe('5');
    expect(persisted.subject).toBe('Test task');
    expect(persisted.owner).toBe('bob');
    expect(persisted.status).toBe('pending');
    // CLI requires these fields for Zod schema validation
    expect(persisted.description).toBe('');
    expect(persisted.blocks).toEqual([]);
    expect(persisted.blockedBy).toEqual([]);
  });

  it('createTask preserves provided description, blocks, blockedBy', async () => {
    await writer.createTask('my-team', {
      id: '6',
      subject: 'Task with details',
      description: 'Some description',
      status: 'pending',
      blocks: ['7'],
      blockedBy: ['3'],
    });

    const writtenPath = '/mock/tasks/my-team/6.json';
    const persisted = JSON.parse(hoisted.files.get(writtenPath) ?? '{}') as Record<string, unknown>;
    expect(persisted.description).toBe('Some description');
    expect(persisted.blocks).toEqual(['7']);
    expect(persisted.blockedBy).toEqual(['3']);
  });

  it('updates status and preserves other fields', async () => {
    hoisted.files.set(
      taskPath,
      JSON.stringify({
        id: '12',
        subject: 'task',
        owner: 'alice',
        status: 'pending',
      })
    );

    await writer.updateStatus('my-team', '12', 'in_progress');

    const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}') as Record<string, string>;
    expect(persisted).toMatchObject({
      id: '12',
      subject: 'task',
      owner: 'alice',
      status: 'in_progress',
    });
  });

  it('throws when verify detects conflicting status', async () => {
    hoisted.files.set(
      taskPath,
      JSON.stringify({
        id: '12',
        subject: 'task',
        status: 'pending',
      })
    );
    hoisted.setVerifyOverride(
      JSON.stringify({
        id: '12',
        subject: 'task',
        status: 'pending',
      })
    );

    await expect(writer.updateStatus('my-team', '12', 'in_progress')).rejects.toThrow(
      'Task status update verification failed: 12'
    );
  });

  describe('historyEvents', () => {
    it('createTask records initial task_created event', async () => {
      await writer.createTask('my-team', {
        id: '10',
        subject: 'New task',
        status: 'pending',
        createdBy: 'alice',
      });

      const writtenPath = '/mock/tasks/my-team/10.json';
      const persisted = JSON.parse(hoisted.files.get(writtenPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(1);
      expect(persisted.historyEvents[0]).toMatchObject({
        type: 'task_created',
        status: 'pending',
        actor: 'alice',
      });
      expect(typeof persisted.historyEvents[0].id).toBe('string');
      expect(typeof persisted.historyEvents[0].timestamp).toBe('string');
    });

    it('createTask with in_progress records initial task_created event', async () => {
      await writer.createTask('my-team', {
        id: '11',
        subject: 'Start immediately',
        status: 'in_progress',
        createdBy: 'bob',
      });

      const writtenPath = '/mock/tasks/my-team/11.json';
      const persisted = JSON.parse(hoisted.files.get(writtenPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(1);
      expect(persisted.historyEvents[0]).toMatchObject({
        type: 'task_created',
        status: 'in_progress',
        actor: 'bob',
      });
    });

    it('createTask without createdBy omits actor', async () => {
      await writer.createTask('my-team', {
        id: '13',
        subject: 'No author',
        status: 'pending',
      });

      const writtenPath = '/mock/tasks/my-team/13.json';
      const persisted = JSON.parse(hoisted.files.get(writtenPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(1);
      expect(persisted.historyEvents[0].type).toBe('task_created');
      expect(persisted.historyEvents[0].actor).toBeUndefined();
    });

    it('updateStatus appends status_changed event', async () => {
      hoisted.files.set(
        taskPath,
        JSON.stringify({
          id: '12',
          subject: 'task',
          status: 'pending',
          historyEvents: [
            { type: 'task_created', id: 'ev1', status: 'pending', timestamp: '2024-01-01T00:00:00.000Z', actor: 'user' },
          ],
        })
      );

      await writer.updateStatus('my-team', '12', 'in_progress', 'alice');

      const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(2);
      expect(persisted.historyEvents[1]).toMatchObject({
        type: 'status_changed',
        from: 'pending',
        to: 'in_progress',
        actor: 'alice',
      });
    });

    it('updateStatus works on task without historyEvents', async () => {
      hoisted.files.set(
        taskPath,
        JSON.stringify({
          id: '12',
          subject: 'legacy task',
          status: 'pending',
        })
      );

      await writer.updateStatus('my-team', '12', 'in_progress');

      const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(1);
      expect(persisted.historyEvents[0]).toMatchObject({
        type: 'status_changed',
        from: 'pending',
        to: 'in_progress',
      });
      expect(persisted.historyEvents[0].actor).toBeUndefined();
    });

    it('softDelete appends status_changed to deleted', async () => {
      hoisted.files.set(
        taskPath,
        JSON.stringify({
          id: '12',
          subject: 'task',
          status: 'in_progress',
          historyEvents: [
            { type: 'task_created', id: 'ev1', status: 'pending', timestamp: '2024-01-01T00:00:00.000Z' },
            { type: 'status_changed', id: 'ev2', from: 'pending', to: 'in_progress', timestamp: '2024-01-01T00:01:00.000Z' },
          ],
        })
      );

      await writer.softDelete('my-team', '12', 'user');

      const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(3);
      expect(persisted.historyEvents[2]).toMatchObject({
        type: 'status_changed',
        from: 'in_progress',
        to: 'deleted',
        actor: 'user',
      });
    });

    it('restoreTask appends status_changed to pending', async () => {
      hoisted.files.set(
        taskPath,
        JSON.stringify({
          id: '12',
          subject: 'task',
          status: 'deleted',
          deletedAt: '2024-01-01T00:02:00.000Z',
          historyEvents: [
            { type: 'task_created', id: 'ev1', status: 'pending', timestamp: '2024-01-01T00:00:00.000Z' },
            { type: 'status_changed', id: 'ev2', from: 'pending', to: 'deleted', timestamp: '2024-01-01T00:02:00.000Z' },
          ],
        })
      );

      await writer.restoreTask('my-team', '12', 'user');

      const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}');
      expect(persisted.status).toBe('pending');
      expect(persisted.historyEvents).toHaveLength(3);
      expect(persisted.historyEvents[2]).toMatchObject({
        type: 'status_changed',
        from: 'deleted',
        to: 'pending',
        actor: 'user',
      });
    });

    it('restoreTask defaults actor to user when not provided', async () => {
      hoisted.files.set(
        taskPath,
        JSON.stringify({
          id: '12',
          subject: 'task',
          status: 'deleted',
          deletedAt: '2024-01-01T00:02:00.000Z',
        })
      );

      await writer.restoreTask('my-team', '12');

      const persisted = JSON.parse(hoisted.files.get(taskPath) ?? '{}');
      expect(persisted.historyEvents).toHaveLength(1);
      expect(persisted.historyEvents[0]).toMatchObject({
        type: 'status_changed',
        from: 'deleted',
        to: 'pending',
        actor: 'user',
      });
    });
  });
});
