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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: hoisted.readFile,
    },
  };
});

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

vi.mock('../../../../src/main/services/team/fileLock', () => ({
  withFileLock: async (_path: string, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock('../../../../src/main/services/team/inboxLock', () => ({
  withInboxLock: async (_path: string, fn: () => Promise<unknown>) => await fn(),
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

  it('includes source field in payload when provided in request', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'task assigned',
      summary: 'New task #1 assigned',
      source: 'system_notification',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].source).toBe('system_notification');
  });

  it('preserves provided message identity fields for dedup across live and persisted rows', async () => {
    const result = await writer.sendMessage('my-team', {
      member: 'alice',
      from: 'team-lead',
      to: 'team-best.user',
      text: 'Hello cross-team',
      summary: 'Cross-team response',
      messageId: 'lead-sendmsg-run-1-123',
      relayOfMessageId: 'msg-original-1',
      timestamp: '2026-03-10T00:33:55.000Z',
      source: 'lead_process',
      color: 'purple',
      toolSummary: '1 tool',
      toolCalls: [{ name: 'SendMessage', preview: 'team-best.user' }],
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(result.messageId).toBe('lead-sendmsg-run-1-123');
    expect(persisted[0]).toMatchObject({
      from: 'team-lead',
      to: 'team-best.user',
      text: 'Hello cross-team',
      summary: 'Cross-team response',
      messageId: 'lead-sendmsg-run-1-123',
      relayOfMessageId: 'msg-original-1',
      timestamp: '2026-03-10T00:33:55.000Z',
      source: 'lead_process',
      color: 'purple',
      toolSummary: '1 tool',
      toolCalls: [{ name: 'SendMessage', preview: 'team-best.user' }],
    });
  });

  it('omits source field from payload when not provided in request', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'hello',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toHaveProperty('source');
  });
});
