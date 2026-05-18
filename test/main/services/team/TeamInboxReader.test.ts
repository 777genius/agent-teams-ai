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
    const legacy = messages.find((m) => m.text === 'legacy');
    expect(legacy).toBeDefined();
    expect(legacy!.messageId).toBe('inbox-3d4d01c54fc0dc52');
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

  it('preserves member-work-sync payload hash without changing visible message fields', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'system',
          to: 'alice',
          text: 'Please reconcile current work.',
          timestamp: '2026-01-01T02:30:00.000Z',
          read: false,
          messageId: 'member-work-sync:my-team:alice:agenda',
          source: 'system_notification',
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'agenda_sync',
          workSyncPayloadHash: 'sha256:work-sync',
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'member-work-sync:my-team:alice:agenda',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncPayloadHash: 'sha256:work-sync',
    });
  });

  it('preserves task-stall remediation semantic kind', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'system',
          to: 'alice',
          text: 'Please continue the stalled task or report a blocker.',
          timestamp: '2026-01-01T02:45:00.000Z',
          read: false,
          messageId: 'task-stall:my-team:alice:task-a',
          source: 'system_notification',
          messageKind: 'task_stall_remediation',
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'task-stall:my-team:alice:task-a',
      messageKind: 'task_stall_remediation',
    });
  });

  it('preserves agent error semantic kind from the team lead inbox', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/team-lead.json',
      JSON.stringify([
        {
          from: 'bob',
          to: 'team-lead',
          text: 'bob hit a mailbox turn execution error. API Error: Credit balance is too low',
          timestamp: '2026-01-01T03:00:00.000Z',
          read: false,
          messageId: 'm-agent-error',
          messageKind: 'agent_error',
          summary: 'Mailbox turn execution failed',
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'team-lead');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'm-agent-error',
      to: 'team-lead',
      messageKind: 'agent_error',
      summary: 'Mailbox turn execution failed',
    });
  });
});
