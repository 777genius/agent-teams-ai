import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const sizes = new Map<string, number>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const stat = vi.fn((filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    const signatureStride = Math.max(1, Math.floor(data.length / 128));
    let signatureValue = Buffer.byteLength(data, 'utf8');
    for (let i = 0; i < data.length; i += signatureStride) {
      signatureValue = (signatureValue * 33 + data.charCodeAt(i)) % 1_000_000_007;
    }
    return Promise.resolve({
      isFile: () => true,
      size: sizes.get(norm(filePath)) ?? Buffer.byteLength(data, 'utf8'),
      mtimeMs: signatureValue,
      ctimeMs: signatureValue,
      dev: 1,
      ino: signatureValue,
    });
  });

  const readdir = vi.fn((dirPath: string) => {
    const entries = dirs.get(norm(dirPath));
    if (!entries) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(entries);
  });

  const readFile = vi.fn((filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(data);
  });

  return { files, dirs, sizes, stat, readdir, readFile };
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

import {
  MAX_INBOX_FILE_BYTES,
  TeamInboxReader,
} from '../../../../src/main/services/team/TeamInboxReader';

describe('TeamInboxReader', () => {
  let reader: TeamInboxReader;
  const inboxDir = '/mock/teams/my-team/inboxes';

  beforeEach(() => {
    reader = new TeamInboxReader();
    hoisted.files.clear();
    hoisted.dirs.clear();
    hoisted.sizes.clear();
    hoisted.stat.mockClear();
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

  it('getMessagesWindow keeps a bounded newest window while revision tracks older source changes', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json', 'bob.json']);
    const writeAlice = (olderText: string) => {
      hoisted.files.set(
        '/mock/teams/my-team/inboxes/alice.json',
        JSON.stringify([
          {
            from: 'alice',
            text: olderText,
            timestamp: '2026-01-01T00:00:00.000Z',
            read: false,
            messageId: 'm-1',
          },
          {
            from: 'alice',
            text: 'alice newest',
            timestamp: '2026-01-03T00:00:00.000Z',
            read: false,
            messageId: 'm-3',
          },
        ])
      );
    };
    writeAlice('older');
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/bob.json',
      JSON.stringify([
        {
          from: 'bob',
          text: 'middle',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
        {
          from: 'bob',
          text: 'bob newest',
          timestamp: '2026-01-04T00:00:00.000Z',
          read: false,
          messageId: 'm-4',
        },
      ])
    );

    const first = await reader.getMessagesWindow('my-team', { limit: 2 });
    expect(first.messages.map((message) => message.messageId)).toEqual(['m-4', 'm-3']);
    expect(first.messages.map((message) => message.to)).toEqual(['bob', 'alice']);
    expect(first.truncated).toBe(true);
    expect(first.sourceMessageCount).toBe(4);

    writeAlice('older changed outside window');
    const second = await reader.getMessagesWindow('my-team', { limit: 2 });
    expect(second.messages.map((message) => message.messageId)).toEqual(['m-4', 'm-3']);
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
  });

  it('getMessagesWindow applies the pagination cursor before bounding the window', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'newest',
          timestamp: '2026-01-04T00:00:00.000Z',
          read: false,
          messageId: 'm-4',
        },
        {
          from: 'alice',
          text: 'cursor row',
          timestamp: '2026-01-03T00:00:00.000Z',
          read: false,
          messageId: 'm-3',
        },
        {
          from: 'alice',
          text: 'older one',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
        {
          from: 'alice',
          text: 'older two',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const window = await reader.getMessagesWindow('my-team', {
      cursor: {
        timestampMs: Date.parse('2026-01-03T00:00:00.000Z'),
        messageId: 'm-3',
      },
      limit: 1,
    });

    expect(window.messages.map((message) => message.messageId)).toEqual(['m-2']);
    expect(window.truncated).toBe(true);
    expect(window.sourceMessageCount).toBe(4);
  });

  it('getMessagesWindow keeps sourceRevision stable across cursor and limit changes', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'newest',
          timestamp: '2026-01-03T00:00:00.000Z',
          read: false,
          messageId: 'm-3',
        },
        {
          from: 'alice',
          text: 'middle',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
        {
          from: 'alice',
          text: 'oldest',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const head = await reader.getMessagesWindow('my-team', { limit: 1 });
    const older = await reader.getMessagesWindow('my-team', {
      cursor: {
        timestampMs: Date.parse('2026-01-03T00:00:00.000Z'),
        messageId: 'm-3',
      },
      limit: 2,
    });

    expect(older.messages.map((message) => message.messageId)).toEqual(['m-2', 'm-1']);
    expect(older.sourceRevision).toBe(head.sourceRevision);
  });

  it('keeps sourceRevision stable across directory and inbox-row ordering', async () => {
    const writeInboxes = (reversed: boolean) => {
      hoisted.dirs.set(
        inboxDir,
        reversed ? ['Alice-2.json', 'Alice.json'] : ['Alice.json', 'Alice-2.json']
      );
      const aliceRows = [
        {
          from: 'alice',
          text: 'first',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
        {
          from: 'alice',
          text: 'second',
          timestamp: '2026-01-02T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
      ];
      const duplicateRows = [
        {
          from: 'alice',
          text: 'third',
          timestamp: '2026-01-03T00:00:00.000Z',
          read: false,
          messageId: 'm-3',
        },
        {
          from: 'alice',
          text: 'fourth',
          timestamp: '2026-01-04T00:00:00.000Z',
          read: false,
          messageId: 'm-4',
        },
      ];
      hoisted.files.set(
        '/mock/teams/my-team/inboxes/Alice.json',
        JSON.stringify(reversed ? [...aliceRows].reverse() : aliceRows)
      );
      hoisted.files.set(
        '/mock/teams/my-team/inboxes/Alice-2.json',
        JSON.stringify(reversed ? [...duplicateRows].reverse() : duplicateRows)
      );
    };
    writeInboxes(false);
    const forward = await reader.getMessagesWindow('my-team', { limit: 10 });

    writeInboxes(true);
    reader = new TeamInboxReader();
    const reverse = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(reverse.messages.map((message) => message.messageId)).toEqual(
      forward.messages.map((message) => message.messageId)
    );
    expect(reverse.sourceRevision).toBe(forward.sourceRevision);
  });

  it('getMessagesWindow ignores native bootstrap-control text in sourceRevision', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    const writeInbox = (controlText: string) => {
      hoisted.files.set(
        '/mock/teams/my-team/inboxes/alice.json',
        JSON.stringify([
          {
            from: 'team-lead',
            text: controlText,
            timestamp: '2026-01-04T00:00:00.000Z',
            read: false,
            messageId: 'internal-bootstrap-control',
          },
          {
            from: 'alice',
            text: 'visible message',
            timestamp: '2026-01-03T00:00:00.000Z',
            read: false,
            messageId: 'visible',
          },
        ])
      );
    };
    writeInbox(
      '<agent_teams_native_bootstrap_control>\nprivate v1\n</agent_teams_native_bootstrap_control>'
    );

    const first = await reader.getMessagesWindow('my-team', { limit: 10 });
    writeInbox(
      '<agent_teams_native_bootstrap_control>\nprivate v2\n</agent_teams_native_bootstrap_control>'
    );
    const second = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(second.messages.map((message) => message.messageId)).toEqual([
      'internal-bootstrap-control',
      'visible',
    ]);
    expect(second.sourceRevision).toBe(first.sourceRevision);
  });

  it('getMessagesWindow tracks user-authored native bootstrap-control quotes in sourceRevision', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    const writeInbox = (quotedText: string) => {
      hoisted.files.set(
        '/mock/teams/my-team/inboxes/alice.json',
        JSON.stringify([
          {
            from: 'user',
            source: 'user_sent',
            text: quotedText,
            timestamp: '2026-01-04T00:00:00.000Z',
            read: false,
            messageId: 'visible-bootstrap-control-quote',
          },
        ])
      );
    };
    writeInbox(
      '<agent_teams_native_bootstrap_control>\nquoted v1\n</agent_teams_native_bootstrap_control>'
    );

    const first = await reader.getMessagesWindow('my-team', { limit: 10 });
    writeInbox(
      '<agent_teams_native_bootstrap_control>\nquoted v2\n</agent_teams_native_bootstrap_control>'
    );
    const second = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(second.messages.map((message) => message.messageId)).toEqual([
      'visible-bootstrap-control-quote',
    ]);
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
  });

  it('getMessagesWindow keeps same-timestamp rows after the cursor by message id', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'same timestamp before cursor',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
        {
          from: 'alice',
          text: 'cursor row',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-2',
        },
        {
          from: 'alice',
          text: 'same timestamp after cursor',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-3',
        },
      ])
    );

    const window = await reader.getMessagesWindow('my-team', {
      cursor: {
        timestampMs: Date.parse('2026-01-01T00:00:00.000Z'),
        messageId: 'm-2',
      },
      limit: 10,
    });

    expect(window.messages.map((message) => message.messageId)).toEqual(['m-3']);
  });

  it('getMessagesWindow parses objects with quoted braces and nested tool metadata', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'quoted "{ brace }" and escaped slash \\\\ ok',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
          toolCalls: [
            {
              name: 'inspect',
              preview: '{"nested": true, "value": "{still string}"}',
            },
          ],
        },
      ])
    );

    const window = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(window.messages).toHaveLength(1);
    expect(window.messages[0]).toMatchObject({
      messageId: 'm-1',
      text: 'quoted "{ brace }" and escaped slash \\\\ ok',
      toolCalls: [{ name: 'inspect', preview: '{"nested": true, "value": "{still string}"}' }],
    });
  });

  it('getMessagesWindow rejects arrays with trailing non-whitespace data', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      `${JSON.stringify([
        {
          from: 'alice',
          text: 'valid before garbage',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])} trailing`
    );

    const window = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(window.messages).toEqual([]);
    expect(window.sourceMessageCount).toBe(0);
  });

  it('getMessagesWindow rejects invalid comma placement like JSON.parse', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    const validMessage = JSON.stringify({
      from: 'alice',
      text: 'valid before invalid comma',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: false,
      messageId: 'm-1',
    });

    for (const raw of [
      `[${validMessage},]`,
      `[,${validMessage}]`,
      `[${validMessage},,${validMessage}]`,
    ]) {
      hoisted.files.set('/mock/teams/my-team/inboxes/alice.json', raw);
      const window = await reader.getMessagesWindow('my-team', { limit: 10 });
      expect(window.messages).toEqual([]);
      expect(window.sourceMessageCount).toBe(0);
    }
  });

  it('getMessagesWindow skips valid non-object array items instead of rejecting the file', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        null,
        'noise',
        42,
        true,
        ['nested', 'noise'],
        {
          from: 'alice',
          text: 'valid after noise',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const window = await reader.getMessagesWindow('my-team', { limit: 10 });

    expect(window.messages.map((message) => message.messageId)).toEqual(['m-1']);
    expect(window.sourceMessageCount).toBe(1);
  });

  it('caches getMessagesFor results while the inbox file signature is unchanged', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'cached',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const first = await reader.getMessagesFor('my-team', 'alice');
    first[0].to = 'mutated';
    const second = await reader.getMessagesFor('my-team', 'alice');

    expect(hoisted.stat).toHaveBeenCalledTimes(2);
    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(second).toEqual([
      expect.objectContaining({
        messageId: 'm-1',
        text: 'cached',
        to: undefined,
      }),
    ]);
  });

  it('does not cache oversized parsed inbox payloads', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'x'.repeat(2_150_000),
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-large',
        },
      ])
    );

    const first = await reader.getMessagesFor('my-team', 'alice');
    const second = await reader.getMessagesFor('my-team', 'alice');

    expect(first[0]?.messageId).toBe('m-large');
    expect(second[0]?.messageId).toBe('m-large');
    expect(hoisted.readFile).toHaveBeenCalledTimes(2);
  });

  it('reads inboxes at the shared byte limit and skips files above it', async () => {
    const inboxPath = '/mock/teams/my-team/inboxes/alice.json';
    hoisted.files.set(
      inboxPath,
      JSON.stringify([
        {
          from: 'alice',
          text: 'at limit',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-limit',
        },
      ])
    );
    hoisted.sizes.set(inboxPath, MAX_INBOX_FILE_BYTES);

    expect(await reader.getMessagesFor('my-team', 'alice')).toHaveLength(1);

    hoisted.sizes.set(inboxPath, MAX_INBOX_FILE_BYTES + 1);
    expect(await reader.getMessagesFor('my-team', 'alice')).toEqual([]);
    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
  });

  it('evicts old inbox payloads when the cache byte budget is exceeded', async () => {
    const memberCount = 18;
    for (let index = 0; index < memberCount; index++) {
      hoisted.files.set(
        `/mock/teams/my-team/inboxes/member-${index}.json`,
        JSON.stringify([
          {
            from: `member-${index}`,
            text: 'x'.repeat(950_000),
            timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
            read: false,
            messageId: `m-${index}`,
          },
        ])
      );
    }

    for (let index = 0; index < memberCount; index++) {
      await reader.getMessagesFor('my-team', `member-${index}`);
    }
    await reader.getMessagesFor('my-team', 'member-0');

    expect(hoisted.readFile).toHaveBeenCalledTimes(memberCount + 1);
  });

  it('re-reads getMessagesFor results when the inbox file signature changes', async () => {
    const inboxPath = '/mock/teams/my-team/inboxes/alice.json';
    hoisted.files.set(
      inboxPath,
      JSON.stringify([
        {
          from: 'alice',
          text: 'first',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );
    expect((await reader.getMessagesFor('my-team', 'alice'))[0]?.text).toBe('first');

    hoisted.files.set(
      inboxPath,
      JSON.stringify([
        {
          from: 'alice',
          text: 'second',
          timestamp: '2026-01-01T00:00:01.000Z',
          read: false,
          messageId: 'm-2',
        },
      ])
    );

    expect((await reader.getMessagesFor('my-team', 'alice'))[0]?.text).toBe('second');
    expect(hoisted.readFile).toHaveBeenCalledTimes(2);
  });

  it('does not let getMessages recipient backfill mutate cached member inbox rows', async () => {
    hoisted.dirs.set(inboxDir, ['alice.json']);
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'alice',
          text: 'legacy recipient',
          timestamp: '2026-01-01T00:00:00.000Z',
          read: false,
          messageId: 'm-1',
        },
      ])
    );

    const merged = await reader.getMessages('my-team');
    const direct = await reader.getMessagesFor('my-team', 'alice');

    expect(merged[0]?.to).toBe('alice');
    expect(direct[0]?.to).toBeUndefined();
    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
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

  it('preserves valid structured agent-error and runtime-recovery contracts', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'bob',
          text: 'API Error: 529 overloaded_error',
          timestamp: '2026-01-01T03:00:00.000Z',
          read: false,
          messageId: 'm-agent-error-structured',
          messageKind: 'agent_error',
          agentError: {
            schemaVersion: 1,
            type: 'api_error',
            phase: 'terminal',
            detail: 'API Error: 529 overloaded_error',
            failedMessageId: 'runtime-recovery-1-attempt-1',
            runtimeSessionId: 'session-1',
            bootstrapRunId: 'run-1',
            innerRecoveryAttempts: 3,
          },
        },
        {
          from: 'system',
          text: 'Continue safely',
          timestamp: '2026-01-01T03:01:00.000Z',
          read: false,
          messageId: 'runtime-recovery-1-attempt-1',
          messageKind: 'runtime_recovery_nudge',
          runtimeRecovery: {
            schemaVersion: 1,
            recoveryId: 'runtime-recovery-1',
            sourceFailureId: 'failure-1',
            attempt: 1,
            reasonCode: 'provider_overloaded',
            payloadHash: 'sha256:payload',
          },
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(
      messages.find((message) => message.messageId === 'm-agent-error-structured')?.agentError
    ).toMatchObject({
      failedMessageId: 'runtime-recovery-1-attempt-1',
      innerRecoveryAttempts: 3,
    });
    expect(
      messages.find((message) => message.messageId === 'runtime-recovery-1-attempt-1')
        ?.runtimeRecovery
    ).toEqual({
      schemaVersion: 1,
      recoveryId: 'runtime-recovery-1',
      sourceFailureId: 'failure-1',
      attempt: 1,
      reasonCode: 'provider_overloaded',
      payloadHash: 'sha256:payload',
    });
  });

  it('drops malformed structured metadata while keeping the compatible inbox row', async () => {
    hoisted.files.set(
      '/mock/teams/my-team/inboxes/alice.json',
      JSON.stringify([
        {
          from: 'bob',
          text: 'API Error: 529 overloaded_error',
          timestamp: '2026-01-01T03:00:00.000Z',
          read: false,
          messageId: 'm-agent-error-malformed',
          messageKind: 'agent_error',
          agentError: {
            schemaVersion: 1,
            type: 'api_error',
            phase: 'terminal',
            detail: 'API Error: 529 overloaded_error',
            failedMessageId: 'failed-1',
            runtimeSessionId: 123,
            innerRecoveryAttempts: -1,
          },
        },
      ])
    );

    const messages = await reader.getMessagesFor('my-team', 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'm-agent-error-malformed',
      messageKind: 'agent_error',
      agentError: undefined,
    });
  });
});
