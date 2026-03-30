import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const stat = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return {
      isFile: () => true,
      size: Buffer.byteLength(data, 'utf8'),
    };
  });

  const readdir = vi.fn(async (dirPath: string) => {
    const entries = dirs.get(norm(dirPath));
    if (!entries) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return entries;
  });

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  return { files, dirs, stat, readdir, readFile };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: hoisted.stat,
      readdir: hoisted.readdir,
      readFile: hoisted.readFile,
    },
  };
});

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';

describe('TeamInboxReader', () => {
  const reader = new TeamInboxReader();
  const inboxDir = '/mock/teams/my-team/inboxes';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.dirs.clear();
    hoisted.readdir.mockClear();
    hoisted.readFile.mockClear();
  });

  it('listInboxNames filters only visible json files', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json', '.hidden.json', 'bob.json', 'note.txt']);

    const names = await reader.listInboxNames('my-team');
    expect(names).toEqual(['alice', 'bob']);
  });

  it('getMessagesFor returns empty for corrupted JSON', async () => {
    hoisted.files.set('/mock/teams/my-team/inboxes/alice.json', '{bad');
    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toEqual([]);
  });

  it('getMessages merges and sorts by newest timestamp', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json', 'bob.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'older',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/bob.json',
      JSON.stringify([
        {
          from: 'bob',
          text: 'newer',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
      ])
    );

    const merged = await reader.getMessages('my-team');
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('newer');
    expect(merged[1].text).toBe('older');
  });

  it('generates deterministic messageId for legacy inbox rows without messageId', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'legacy',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
        },
        {
          from: 'alice',
          text: 'supported',
          timestamp: '2026-01-01T01:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toHaveLength(2);
    // Legacy row gets a deterministic hash-based messageId
    const legacy = messages.find((m) => m.text === 'legacy');
    expect(legacy).toBeDefined();
    expect(legacy!.messageId).toMatch(/^inbox-[a-f0-9]{16}$/);
    // Explicit messageId is preserved
    const supported = messages.find((m) => m.text === 'supported');
    expect(supported).toBeDefined();
    expect(supported!.messageId).toBe('m-1');
  });

  it('preserves task comment notification semantic kind', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'bob',
          to: 'team-lead',
          text: 'Notification payload',
          timestamp: '2026-01-01T02:00:00.000Z',
          read: false,
          messageId: 'm-task-comment',
          source: 'system_notification',
          messageKind: 'task_comment_notification',
          summary: 'Comment on #abcd1234',
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'm-task-comment',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      summary: 'Comment on #abcd1234',
    });
  });
});
