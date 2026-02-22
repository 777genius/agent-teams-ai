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
});
