// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, TeamConfig } from '../../../../src/shared/types/team';

const fixture = vi.hoisted(() => ({
  teamsRoot: null as string | null,
  failedReadPath: null as string | null,
  failureMode: 'eio' as 'eio' | 'timeout' | 'remove',
}));

// Every production reader path is redirected to a fresh test-owned directory.
vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => {
    if (!fixture.teamsRoot) throw new Error('History gate sandbox is not initialized');
    return fixture.teamsRoot;
  },
}));

// Inject only one storage failure. All successful reads use the real filesystem.
vi.mock('../../../../src/main/utils/fsRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/fsRead')>();
  return {
    ...actual,
    readFileUtf8WithTimeout: async (filePath: string, timeoutMs: number): Promise<string> => {
      if (filePath === fixture.failedReadPath) {
        if (fixture.failureMode === 'timeout')
          throw new actual.FileReadTimeoutError(filePath, timeoutMs);
        if (fixture.failureMode === 'remove') {
          await rm(filePath);
          return actual.readFileUtf8WithTimeout(filePath, timeoutMs);
        }
        const error = new Error('Synthetic inbox source read failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return actual.readFileUtf8WithTimeout(filePath, timeoutMs);
    },
  };
});

import {
  MAX_INBOX_FILE_BYTES,
  TeamInboxReader,
} from '../../../../src/main/services/team/TeamInboxReader';
import { TeamMessageFeedService } from '../../../../src/main/services/team/TeamMessageFeedService';

const SANDBOX_PREFIX = 'agent-teams-history-gate-';
const TEAM_NAME = 'sandbox-history-retrieval';
const T = '2026-10-06T00:00:01.000Z';
const OLDER_T = '2026-10-06T00:00:00.000Z';
const config: TeamConfig = {
  name: TEAM_NAME,
  members: [{ name: 'team-lead', role: 'Lead' }],
};

function message(messageId: string, timestamp: string, text: string): InboxMessage {
  return { messageId, timestamp, text, from: 'alice', to: 'user', read: false, source: 'inbox' };
}

function sandboxRoot(): string {
  if (!fixture.teamsRoot) throw new Error('History gate sandbox is not initialized');
  return fixture.teamsRoot;
}

function inboxPath(member: string): string {
  return join(sandboxRoot(), TEAM_NAME, 'inboxes', `${member}.json`);
}

async function writeInbox(member: string, messages: readonly InboxMessage[]): Promise<void> {
  await writeFile(inboxPath(member), JSON.stringify(messages), 'utf8');
}

function createFeed(
  reader: TeamInboxReader,
  sentMessages: readonly InboxMessage[] = []
): TeamMessageFeedService {
  return new TeamMessageFeedService({
    getConfig: async () => config,
    getInboxMessages: async () => {
      throw new Error('History gate forbids a full-inbox fallback');
    },
    getInboxMessagesWindow: (teamName, options) => reader.getMessagesWindow(teamName, options),
    getLeadSessionMessages: async () => [],
    getSentMessages: async () => [...sentMessages],
  });
}

async function enumerate(service: TeamMessageFeedService): Promise<string[]> {
  const messageIds: string[] = [];
  const requestedCursors = new Set<string>();
  let cursor: string | null = null;
  // A fixture termination guard, not a production page or resource budget.
  for (let request = 0; request < 4; request += 1) {
    const page = await service.getPage(TEAM_NAME, { cursor, limit: 50 });
    for (const row of page.messages) {
      expect(typeof row.messageId).toBe('string');
      messageIds.push(row.messageId!);
    }
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      return messageIds;
    }
    expect(page.nextCursor, 'A continuing page must have a progress cursor').not.toBeNull();
    const nextCursor = page.nextCursor!;
    expect(requestedCursors.has(nextCursor), 'Pagination must not repeat its frontier').toBe(false);
    requestedCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('History gate fixture did not reach trusted exhaustion');
}

describe('Team message history retrieval prerequisites', () => {
  beforeEach(async () => {
    fixture.failedReadPath = null;
    fixture.failureMode = 'eio';
    fixture.teamsRoot = await mkdtemp(join(tmpdir(), SANDBOX_PREFIX));
    await mkdir(join(sandboxRoot(), TEAM_NAME, 'inboxes'), { recursive: true });
  });

  afterEach(async () => {
    fixture.failedReadPath = null;
    const ownedRoot = fixture.teamsRoot;
    fixture.teamsRoot = null;
    if (!ownedRoot) return;
    // Cleanup can only target this test's exact mkdtemp root.
    if (dirname(ownedRoot) !== tmpdir() || !basename(ownedRoot).startsWith(SANDBOX_PREFIX)) {
      throw new Error('Refusing cleanup outside the history gate sandbox');
    }
    await rm(ownedRoot, { recursive: true, force: true });
  });

  it('enumerates dup and older after 201 duplicate newest rows without false EOF', async () => {
    const duplicate = message('dup', T, 'The same durable row copied 201 times');
    await writeInbox('user', [
      ...Array.from({ length: 201 }, () => ({ ...duplicate })),
      message('older', OLDER_T, 'The older durable record must remain reachable'),
    ]);
    const reader = new TeamInboxReader();

    // Independent literal oracle: no production comparator/dedup creates this expectation.
    expect(await enumerate(createFeed(reader))).toEqual(['dup', 'older']);
  });

  it('keeps a separate sent lower row behind the unresolved inbox range and enumerates every row', async () => {
    const duplicate = message('dup', '2026-10-06T00:00:02.000Z', 'Repeated inbox record');
    await writeInbox('user', [
      ...Array.from({ length: 201 }, () => ({ ...duplicate })),
      message('older', T, 'Inbox record hidden behind duplicate depletion'),
    ]);
    // SENT is a separate feed source, not another globally capped inbox member.
    const lower: InboxMessage = {
      ...message('lower', OLDER_T, 'Separate sent source record'),
      from: 'user',
      to: 'alice',
      source: 'user_sent',
    };
    const service = createFeed(new TeamInboxReader(), [lower]);
    expect(await enumerate(service)).toEqual(['dup', 'older', 'lower']);

    const first = await service.getPage(TEAM_NAME, { limit: 50 });
    // A successful prefix can defer lower or refill older first, but cannot leap over older.
    for (const rows of [first.messages, first.durableWindowMessages]) {
      const ids = rows.map((row) => row.messageId);
      if (!ids.includes('lower')) continue;
      expect(
        ids.indexOf('older'),
        'Lower is unproven while older is hidden'
      ).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf('lower')).toBeGreaterThan(ids.indexOf('older'));
    }
  });

  it('changes revision when equal-score duplicate taskRefs rows swap the visible first winner', async () => {
    const row = message('same-id', T, 'Conflicting duplicate task references');
    const first: InboxMessage = {
      ...row,
      taskRefs: [{ teamName: TEAM_NAME, taskId: '1', displayId: '1' }],
    };
    const second: InboxMessage = {
      ...row,
      taskRefs: [{ teamName: TEAM_NAME, taskId: '2', displayId: '2' }],
    };
    const service = createFeed(new TeamInboxReader());
    await writeInbox('user', [first, second]);
    const before = await service.getPage(TEAM_NAME, { limit: 50 });
    expect(before.messages.map((item) => [item.messageId, item.taskRefs])).toEqual([
      ['same-id', [{ teamName: TEAM_NAME, taskId: '1', displayId: '1' }]],
    ]);

    await writeInbox('user', [second, first]);
    service.invalidate(TEAM_NAME);
    const after = await service.getPage(TEAM_NAME, { limit: 50 });
    expect(after.messages.map((item) => [item.messageId, item.taskRefs])).toEqual([
      ['same-id', [{ teamName: TEAM_NAME, taskId: '2', displayId: '2' }]],
    ]);
    expect(
      after.feedRevision,
      'Changed first-winner semantics require a changed revision'
    ).not.toBe(before.feedRevision);
  });

  it('changes the page revision when only an older row structured task reference is rewritten', async () => {
    const reader = new TeamInboxReader();
    const service = createFeed(reader);
    const head = message('head', T, 'Stable visible head');
    const older = message('older', OLDER_T, 'See the referenced task');
    await writeInbox('user', [
      head,
      { ...older, taskRefs: [{ teamName: TEAM_NAME, taskId: '1', displayId: '1' }] },
    ]);
    const before = await service.getPage(TEAM_NAME, { limit: 1 });
    expect(before.messages.map((row) => row.messageId)).toEqual(['head']);

    await writeInbox('user', [
      head,
      { ...older, taskRefs: [{ teamName: TEAM_NAME, taskId: '2', displayId: '2' }] },
    ]);
    service.invalidate(TEAM_NAME);
    const after = await service.getPage(TEAM_NAME, { limit: 1 });
    const rewritten = await service.getPage(TEAM_NAME, { cursor: after.nextCursor, limit: 1 });
    expect(after.messages.map((row) => row.messageId)).toEqual(['head']);
    expect(rewritten.messages[0]?.taskRefs).toEqual([
      { teamName: TEAM_NAME, taskId: '2', displayId: '2' },
    ]);
    expect(
      after.feedRevision,
      'A task-navigation rewrite cannot preserve the trusted revision'
    ).not.toBe(before.feedRevision);
  });

  it('refuses successful exhaustion when one known durable member source fails to read', async () => {
    await writeInbox('alice', [message('healthy', T, 'Healthy source record')]);
    await writeInbox('bob', [
      { ...message('recoverable', OLDER_T, 'Still exists in the failed source'), from: 'bob' },
    ]);
    const service = createFeed(new TeamInboxReader());
    const complete = await service.getPage(TEAM_NAME, { limit: 50 });
    expect(complete.messages.map((row) => row.messageId)).toEqual(['healthy', 'recoverable']);
    expect(complete.hasMore).toBe(false);

    fixture.failedReadPath = inboxPath('bob');
    service.invalidate(TEAM_NAME);
    let outcome: unknown;
    let surfacedFailure = false;
    try {
      outcome = await service.getPage(TEAM_NAME, { limit: 50 });
    } catch (error) {
      // A surfaced storage failure is a valid compatibility behavior until typed outcomes land.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/inbox|source|unavailable|incomplete/i);
      surfacedFailure = true;
    }
    // Proposed explicit unavailable contract. A partial ordinary page must fail this gate.
    if (!surfacedFailure) expect(outcome).toMatchObject({ kind: 'unavailable' });

    fixture.failedReadPath = null;
    service.invalidate(TEAM_NAME);
    const recovered = await service.getPage(TEAM_NAME, { limit: 50 });
    expect(recovered.messages.map((row) => [row.messageId, row.text])).toEqual([
      ['healthy', 'Healthy source record'],
      ['recoverable', 'Still exists in the failed source'],
    ]);
    expect(recovered.hasMore).toBe(false);
  });

  it('rereads a discarded equal-timestamp range from its original input cursor exactly once', async () => {
    await writeInbox('user', [
      message('a', T, 'First'),
      message('b', T, 'Second'),
      message('c', T, 'Third'),
      message('d', T, 'Fourth'),
    ]);
    const reader = new TeamInboxReader();
    const service = createFeed(reader);
    const head = await service.getPage(TEAM_NAME, { limit: 2 });
    expect(head.messages.map((row) => row.messageId)).toEqual(['a', 'b']);
    expect(head.nextCursor).toBe('2026-10-06T00:00:01.000Z|b');
    const inputCursor = head.nextCursor;
    const older = await service.getPage(TEAM_NAME, { cursor: inputCursor, limit: 2 });
    expect(older.messages.map((row) => row.messageId)).toEqual(['c', 'd']);
    expect(older.hasMore).toBe(false);

    // A fresh service avoids proving reread only through the page-source result cache.
    const restored = await createFeed(new TeamInboxReader()).getPage(TEAM_NAME, {
      cursor: inputCursor,
      limit: 2,
    });
    expect(restored.messages.map((row) => row.messageId)).toEqual(['c', 'd']);
    expect(restored.feedRevision).toBe(head.feedRevision);
    expect(restored.nextCursor).toBeNull();
  });

  const metadataChanges: { name: string; patch: Partial<InboxMessage> }[] = [
    { name: 'read receipt', patch: { read: true } },
    {
      name: 'attachment',
      patch: {
        attachments: [{ id: 'file-1', filename: 'proof.txt', mimeType: 'text/plain', size: 12 }],
      },
    },
    {
      name: 'conversation',
      patch: { conversationId: 'thread-2', replyToConversationId: 'parent-2' },
    },
    { name: 'delivery action', patch: { actionMode: 'ask', commentId: 'comment-2' } },
    {
      name: 'tool metadata',
      patch: { toolSummary: '1 tool', toolCalls: [{ name: 'Read', preview: 'proof.txt' }] },
    },
    {
      name: 'runtime failure',
      patch: {
        agentError: {
          schemaVersion: 1,
          type: 'api_error',
          phase: 'terminal',
          detail: 'fixture failure',
          failedMessageId: 'failed-2',
          innerRecoveryAttempts: 1,
        },
      },
    },
    {
      name: 'work sync',
      patch: {
        workSyncIntentKey: 'event-2',
        workSyncRuntimeGeneration: 2,
        workSyncReviewRequestEventIds: ['event-b', 'event-a'],
      },
    },
  ];

  it.each(metadataChanges)(
    'versions an older $name change while the head stays fixed',
    async ({ patch }) => {
      const service = createFeed(new TeamInboxReader());
      const head = message('head', T, 'Fixed head');
      const older = message('older', OLDER_T, 'Fixed older body');
      await writeInbox('user', [head, older]);
      const before = await service.getPage(TEAM_NAME, { limit: 1 });
      await writeInbox('user', [head, { ...older, ...patch }]);
      service.invalidate(TEAM_NAME);
      const after = await service.getPage(TEAM_NAME, { limit: 1 });
      const historical = await service.getPage(TEAM_NAME, { cursor: after.nextCursor, limit: 1 });
      expect(after.messages.map((row) => [row.messageId, row.text])).toEqual([
        ['head', 'Fixed head'],
      ]);
      expect(historical.messages).toHaveLength(1);
      expect(historical.messages[0]).toMatchObject({
        messageId: 'older',
        text: 'Fixed older body',
        ...patch,
      });
      expect(after.feedRevision).not.toBe(before.feedRevision);
    }
  );

  it('canonicalizes nested object keys but preserves structured reference array order', async () => {
    const row = message('older', OLDER_T, 'Task order matters');
    await writeInbox('user', [
      {
        ...row,
        taskRefs: [
          { teamName: TEAM_NAME, taskId: '1', displayId: '1' },
          { teamName: TEAM_NAME, taskId: '2', displayId: '2' },
        ],
      },
    ]);
    const first = await createFeed(new TeamInboxReader()).getPage(TEAM_NAME, { limit: 50 });
    await writeInbox('user', [
      {
        ...row,
        taskRefs: [
          { displayId: '1', taskId: '1', teamName: TEAM_NAME },
          { displayId: '2', taskId: '2', teamName: TEAM_NAME },
        ],
      },
    ]);
    const rekeyed = await createFeed(new TeamInboxReader()).getPage(TEAM_NAME, { limit: 50 });
    expect(rekeyed.feedRevision).toBe(first.feedRevision);
    await writeInbox('user', [
      {
        ...row,
        taskRefs: [
          { teamName: TEAM_NAME, taskId: '2', displayId: '2' },
          { teamName: TEAM_NAME, taskId: '1', displayId: '1' },
        ],
      },
    ]);
    const reordered = await createFeed(new TeamInboxReader()).getPage(TEAM_NAME, { limit: 50 });
    expect(reordered.messages[0]?.taskRefs?.map((ref) => ref.taskId)).toEqual(['2', '1']);
    expect(reordered.feedRevision).not.toBe(first.feedRevision);
  });

  it.each(['timeout', 'remove'] as const)(
    'surfaces a path-free %s read failure and recovers',
    async (mode) => {
      await writeInbox('alice', [message('healthy', T, 'Healthy')]);
      await writeInbox('bob', [message('recoverable', OLDER_T, 'Restored')]);
      fixture.failedReadPath = inboxPath('bob');
      fixture.failureMode = mode;
      const service = createFeed(new TeamInboxReader());
      await expect(service.getPage(TEAM_NAME, { limit: 50 })).rejects.toThrow(
        mode === 'timeout'
          ? 'TEAM_HISTORY_UNAVAILABLE:timeout'
          : 'TEAM_HISTORY_UNAVAILABLE:missing_source'
      );
      fixture.failedReadPath = null;
      await writeInbox('bob', [message('recoverable', OLDER_T, 'Restored')]);
      service.invalidate(TEAM_NAME);
      expect(
        (await service.getPage(TEAM_NAME, { limit: 50 })).messages.map((row) => row.messageId)
      ).toEqual(['healthy', 'recoverable']);
    }
  );

  it('rejects a malformed suffix rather than publishing its healthy prefix', async () => {
    await writeFile(
      inboxPath('alice'),
      `${JSON.stringify([message('healthy', T, 'Prefix')])} torn`,
      'utf8'
    );
    const service = createFeed(new TeamInboxReader());
    await expect(service.getPage(TEAM_NAME, { limit: 50 })).rejects.toThrow(
      'TEAM_HISTORY_UNAVAILABLE:invalid_json'
    );
    await writeInbox('alice', []);
    service.invalidate(TEAM_NAME);
    const recovered = await service.getPage(TEAM_NAME, { limit: 50 });
    expect(recovered.messages).toEqual([]);
    expect(recovered.hasMore).toBe(false);
  });

  it.each([
    { name: 'malformed suffix', raw: `${JSON.stringify([message('prefix', T, 'Prefix')])} torn` },
    { name: 'non-array JSON', raw: JSON.stringify({ messageId: 'not-an-inbox-array' }) },
  ])('refuses a tolerated legacy $name cache as strict window evidence', async ({ raw }) => {
    await writeFile(inboxPath('user'), raw, 'utf8');
    const reader = new TeamInboxReader();
    // Legacy compatibility intentionally tolerates these bytes and warms its cache.
    expect(await reader.getMessagesFor(TEAM_NAME, 'user')).toEqual([]);
    await expect(reader.getMessagesWindow(TEAM_NAME, { limit: 50 })).rejects.toMatchObject({
      message: 'TEAM_HISTORY_UNAVAILABLE:invalid_json',
    });
    // Warm it again so the page wrapper cannot pass only because the failed window evicted it.
    expect(await reader.getMessagesFor(TEAM_NAME, 'user')).toEqual([]);
    await expect(createFeed(reader).getPage(TEAM_NAME, { limit: 50 })).rejects.toMatchObject({
      message: 'TEAM_HISTORY_UNAVAILABLE:invalid_json',
    });
  });

  it('rejects failed listing, non-file and over-guard sources explicitly', async () => {
    const service = createFeed(new TeamInboxReader());
    const directory = join(sandboxRoot(), TEAM_NAME, 'inboxes');
    await rm(directory, { recursive: true });
    await expect(service.getPage(TEAM_NAME, { limit: 50 })).rejects.toThrow(
      'TEAM_HISTORY_UNAVAILABLE:listing_failed'
    );
    await mkdir(directory);
    await mkdir(inboxPath('alice'));
    await expect(service.getPage(TEAM_NAME, { limit: 50 })).rejects.toThrow(
      'TEAM_HISTORY_UNAVAILABLE:non_file'
    );
    await rm(inboxPath('alice'), { recursive: true });
    await writeFile(inboxPath('alice'), ' '.repeat(MAX_INBOX_FILE_BYTES + 1));
    await expect(service.getPage(TEAM_NAME, { limit: 50 })).rejects.toThrow(
      'TEAM_HISTORY_UNAVAILABLE:oversized'
    );
  });

  it('refuses false EOF when the bounded raw prefix contains only hidden controls', async () => {
    const control: InboxMessage = {
      ...message(
        'hidden',
        T,
        '<agent_teams_native_bootstrap_control>private</agent_teams_native_bootstrap_control>'
      ),
      from: 'team-lead',
      source: 'runtime_delivery',
    };
    await writeInbox(
      'user',
      Array.from({ length: 201 }, () => ({ ...control }))
    );
    await expect(
      createFeed(new TeamInboxReader()).getPage(TEAM_NAME, { limit: 50 })
    ).rejects.toThrow('TEAM_HISTORY_UNAVAILABLE:no_progress');
  });

  it('rejects invalid cursor and raw timestamps while separator IDs round-trip', async () => {
    await writeInbox('user', [message('a|b', T, 'First'), message('c|d', T, 'Second')]);
    const service = createFeed(new TeamInboxReader());
    for (const cursor of ['', 'not-a-date|a', `${T}|`]) {
      await expect(service.getPage(TEAM_NAME, { cursor, limit: 1 })).rejects.toThrow(
        'TEAM_HISTORY_UNAVAILABLE:invalid_cursor'
      );
    }
    const head = await service.getPage(TEAM_NAME, { limit: 1 });
    expect(head.nextCursor).toBe(`${T}|a|b`);
    const older = await service.getPage(TEAM_NAME, { cursor: head.nextCursor, limit: 1 });
    expect(older.messages.map((row) => row.messageId)).toEqual(['c|d']);
    await writeInbox('user', [message('bad-time', 'invalid-date', 'Cannot order this record')]);
    service.invalidate(TEAM_NAME);
    await expect(service.getPage(TEAM_NAME, { limit: 1 })).rejects.toThrow(
      'TEAM_HISTORY_UNAVAILABLE:invalid_message'
    );
  });
});
