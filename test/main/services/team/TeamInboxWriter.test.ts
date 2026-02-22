import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  let idCounter = 0;
  let dropWrites = 0;

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    if (dropWrites > 0) {
      dropWrites -= 1;
      files.set(norm(filePath), '[]');
      return;
    }
    files.set(norm(filePath), data);
  });

  return {
    files,
    readFile,
    atomicWrite,
    nextId: () => `msg-${++idCounter}`,
    resetCounter: () => {
      idCounter = 0;
    },
    setDropWrites: (count: number) => {
      dropWrites = count;
    },
  };
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: hoisted.nextId,
  };
});

vi.mock('fs', () => ({
  promises: {
    readFile: hoisted.readFile,
  },
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';

describe('TeamInboxWriter', () => {
  const writer = new TeamInboxWriter();
  const inboxPath = '/mock/teams/my-team/inboxes/alice.json';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.resetCounter();
    hoisted.setDropWrites(0);
  });

  it('writes message with metadata and verifies messageId', async () => {
    const result = await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'hello',
      summary: 'greeting',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(result.deliveredToInbox).toBe(true);
    expect(typeof result.messageId).toBe('string');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      from: 'user',
      text: 'hello',
      read: false,
      summary: 'greeting',
      messageId: result.messageId,
    });
    expect(typeof persisted[0].timestamp).toBe('string');
  });

  it('retries write when verify cannot find messageId', async () => {
    hoisted.setDropWrites(2);
    const result = await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'retry me',
    });

    expect(typeof result.messageId).toBe('string');
    expect(hoisted.atomicWrite).toHaveBeenCalledTimes(3);
  });

  it('throws after retries when verify keeps failing', async () => {
    hoisted.setDropWrites(5);
    await expect(
      writer.sendMessage('my-team', {
        member: 'alice',
        text: 'will fail',
      })
    ).rejects.toThrow('Failed to verify inbox write');
    expect(hoisted.atomicWrite).toHaveBeenCalledTimes(3);
  });

  it('keeps both messages on parallel writes to same inbox', async () => {
    await Promise.all([
      writer.sendMessage('my-team', { member: 'alice', text: 'first' }),
      writer.sendMessage('my-team', { member: 'alice', text: 'second' }),
    ]);

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as { text: string }[];
    expect(persisted).toHaveLength(2);
    expect(persisted.map((row) => row.text).sort()).toEqual(['first', 'second']);
  });
});
