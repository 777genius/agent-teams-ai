import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  const realpaths = new Map<string, string>();
  let idCounter = 0;
  let dropWrites = 0;
  let failWrites = 0;
  let failReadAfterWrite = 0;
  let pendingReadFailures = 0;
  const fileLockTails = new Map<string, Promise<void>>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    if (pendingReadFailures > 0) {
      pendingReadFailures -= 1;
      const error = new Error('EIO') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
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
    if (failWrites > 0) {
      failWrites -= 1;
      const error = new Error('EIO') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
    if (dropWrites > 0) {
      dropWrites -= 1;
      files.set(norm(filePath), '[]');
      return;
    }
    files.set(norm(filePath), data);
    if (failReadAfterWrite > 0) {
      failReadAfterWrite -= 1;
      pendingReadFailures += 1;
    }
  });

  const withFileLock = async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
    const key = norm(filePath);
    const previous = fileLockTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    fileLockTails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (fileLockTails.get(key) === tail) {
        fileLockTails.delete(key);
      }
    }
  };

  const realpathSync = vi.fn((filePath: string) => {
    const data = realpaths.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  return {
    files,
    realpaths,
    readFile,
    atomicWrite,
    realpathSync,
    withFileLock,
    nextId: () => `msg-${++idCounter}`,
    resetCounter: () => {
      idCounter = 0;
    },
    setDropWrites: (count: number) => {
      dropWrites = count;
    },
    setFailWrites: (count: number) => {
      failWrites = count;
    },
    setFailReadAfterWrite: (count: number) => {
      failReadAfterWrite = count;
    },
    resetFailures: () => {
      failWrites = 0;
      failReadAfterWrite = 0;
      pendingReadFailures = 0;
      fileLockTails.clear();
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
    realpathSync: Object.assign(hoisted.realpathSync, { native: hoisted.realpathSync }),
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
  withFileLock: hoisted.withFileLock,
  withFileLockSync: (_path: string, fn: () => unknown) => fn(),
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
    hoisted.realpaths.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.realpathSync.mockClear();
    hoisted.resetCounter();
    hoisted.setDropWrites(0);
    hoisted.resetFailures();
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

  it('rejects unsafe inbox member names before writing', async () => {
    await expect(
      writer.sendMessage('my-team', {
        member: '../config',
        text: 'should not escape inboxes',
      })
    ).rejects.toThrow('Invalid inbox path');

    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
    expect(hoisted.files.has('/mock/teams/my-team/config.json')).toBe(false);
  });

  it('rejects symlinked inbox directories outside the teams root before writing', async () => {
    hoisted.realpaths.set('/mock/teams', '/mock/teams');
    hoisted.realpaths.set('/mock/teams/my-team', '/mock/teams/my-team');
    hoisted.realpaths.set('/mock/teams/my-team/inboxes', '/tmp/outside-inboxes');

    await expect(
      writer.sendMessage('my-team', {
        member: 'alice',
        text: 'should not follow symlinked inbox dir',
      })
    ).rejects.toThrow('Invalid inbox path');

    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
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

  it('atomically deduplicates an explicit messageId across writer instances', async () => {
    const firstWriter = new TeamInboxWriter();
    const secondWriter = new TeamInboxWriter();
    const [first, second] = await Promise.all([
      firstWriter.sendMessage('my-team', {
        member: 'alice',
        from: 'system',
        text: 'Start durable task',
        summary: 'Task started',
        source: 'system_notification',
        messageId: 'task-start:my-team:task-1',
      }),
      secondWriter.sendMessage('my-team', {
        member: 'alice',
        from: 'system',
        text: 'Start durable task',
        summary: 'Task started',
        source: 'system_notification',
        messageId: 'task-start:my-team:task-1',
      }),
    ]);

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.messageId).toBe('task-start:my-team:task-1');
    expect([first.deduplicated, second.deduplicated].filter(Boolean)).toHaveLength(1);
  });

  it('merges taskRefs when deduplicating an ordinary explicit messageId', async () => {
    const firstTaskRef = { taskId: 'task-1', displayId: '11111111', teamName: 'my-team' };
    const secondTaskRef = { taskId: 'task-2', displayId: '22222222', teamName: 'my-team' };
    await writer.sendMessage('my-team', {
      member: 'alice',
      from: 'system',
      text: 'Task notification',
      source: 'system_notification',
      messageId: 'notification-1',
      taskRefs: [firstTaskRef],
    });
    const replay = await writer.sendMessage('my-team', {
      member: 'alice',
      from: 'system',
      text: 'Task notification',
      source: 'system_notification',
      messageId: 'notification-1',
      taskRefs: [secondTaskRef],
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(replay.deduplicated).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.taskRefs).toEqual([firstTaskRef, secondTaskRef]);
  });

  it('fails closed when an explicit messageId is reused for different immutable content', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      from: 'system',
      text: 'Original notification',
      source: 'system_notification',
      messageId: 'notification-1',
    });

    await expect(
      writer.sendMessage('my-team', {
        member: 'alice',
        from: 'system',
        text: 'Contradictory notification',
        source: 'system_notification',
        messageId: 'notification-1',
      })
    ).rejects.toThrow('Inbox messageId collision for immutable payload: notification-1');

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as { text: string }[];
    expect(persisted).toEqual([expect.objectContaining({ text: 'Original notification' })]);
  });

  it('retries the same explicit message after a failure before the durable write', async () => {
    hoisted.setFailWrites(1);
    const request = {
      member: 'alice',
      from: 'system',
      text: 'Durable notification',
      source: 'system_notification' as const,
      messageId: 'notification-1',
    };

    await expect(writer.sendMessage('my-team', request)).rejects.toThrow('EIO');
    await expect(writer.sendMessage('my-team', request)).resolves.toMatchObject({
      deliveredToInbox: true,
      messageId: 'notification-1',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
  });

  it('deduplicates retry after a durable write loses its acknowledgement', async () => {
    hoisted.setFailReadAfterWrite(1);
    const request = {
      member: 'alice',
      from: 'system',
      text: 'Durable notification',
      source: 'system_notification' as const,
      messageId: 'notification-1',
    };

    await expect(writer.sendMessage('my-team', request)).rejects.toThrow('EIO');
    await expect(writer.sendMessage('my-team', request)).resolves.toMatchObject({
      deliveredToInbox: true,
      messageId: 'notification-1',
      deduplicated: true,
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
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

  it('persists member-work-sync payload hash when provided', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'sync your work state',
      source: 'system_notification',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncPayloadHash: 'sha256:work-sync',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncPayloadHash: 'sha256:work-sync',
    });
  });

  it('updates an existing member-work-sync row text when message kind and payload hash match', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'sync your work state',
      source: 'system_notification',
      messageId: 'work-sync-1',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncPayloadHash: 'sha256:work-sync',
    });

    const result = await writer.updateMessageText('my-team', {
      member: 'alice',
      messageId: 'work-sync-1',
      text: 'sync your work state\nRequired control API: pass controlUrl "http://127.0.0.1:43123" in both member_work_sync_status and member_work_sync_report.',
      expectedMessageKind: 'member_work_sync_nudge',
      expectedWorkSyncPayloadHash: 'sha256:work-sync',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(result).toEqual({ found: true, updated: true });
    expect(persisted[0]?.text).toContain('controlUrl "http://127.0.0.1:43123"');
    expect(persisted[0]?.workSyncPayloadHash).toBe('sha256:work-sync');
  });

  it('does not update member-work-sync row text when payload hash mismatches', async () => {
    await writer.sendMessage('my-team', {
      member: 'alice',
      text: 'sync your work state',
      source: 'system_notification',
      messageId: 'work-sync-1',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncPayloadHash: 'sha256:work-sync',
    });

    const result = await writer.updateMessageText('my-team', {
      member: 'alice',
      messageId: 'work-sync-1',
      text: 'should not write',
      expectedMessageKind: 'member_work_sync_nudge',
      expectedWorkSyncPayloadHash: 'sha256:different',
    });

    const persisted = JSON.parse(hoisted.files.get(inboxPath) ?? '[]') as Record<string, unknown>[];
    expect(result).toEqual({ found: true, updated: false });
    expect(persisted[0]?.text).toBe('sync your work state');
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

  it('deduplicates repeated runtime delivery replies to the same inbound message', async () => {
    const first = await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: 'Да, я здесь!',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-1',
    });
    const second = await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: ' Да,   я здесь! ',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-1',
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(persisted).toHaveLength(1);
    expect(second).toMatchObject({
      deliveredToInbox: true,
      deduplicated: true,
      messageId: first.messageId,
    });
  });

  it('preserves normalized runtime-delivery dedupe for a repeated explicit messageId', async () => {
    await writer.sendMessage('my-team', {
      member: 'user',
      from: 'Alice',
      to: 'user',
      text: 'Reply with stable identity',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-1',
      messageId: 'runtime-reply-1',
    });
    const replay = await writer.sendMessage('my-team', {
      member: 'user',
      from: ' alice ',
      to: 'USER',
      text: ' Reply   with stable identity ',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-1',
      messageId: 'runtime-reply-1',
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(replay).toMatchObject({
      deliveredToInbox: true,
      deduplicated: true,
      messageId: 'runtime-reply-1',
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.text).toBe('Reply with stable identity');
  });

  it('merges taskRefs when deduplicating repeated runtime delivery replies', async () => {
    const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' };
    const first = await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: 'Готово по задаче.',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-task-1',
    });
    const second = await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: ' Готово   по задаче. ',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-task-1',
      taskRefs: [taskRef],
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(second).toMatchObject({
      deliveredToInbox: true,
      deduplicated: true,
      messageId: first.messageId,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].taskRefs).toEqual([taskRef]);
  });

  it('merges taskRefs into an exact runtime delivery reply row', async () => {
    const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' };
    const written = await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: 'Готово по задаче.',
      source: 'runtime_delivery',
      relayOfMessageId: 'inbound-task-1',
      messageId: 'reply-1',
    });

    const result = await writer.mergeRuntimeDeliveryTaskRefs('my-team', {
      inboxName: 'user',
      messageId: written.messageId,
      relayOfMessageId: 'inbound-task-1',
      from: 'alice',
      taskRefs: [taskRef],
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(result).toMatchObject({
      found: true,
      updated: true,
      message: {
        messageId: 'reply-1',
        taskRefs: [taskRef],
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].taskRefs).toEqual([taskRef]);
  });

  it('does not merge taskRefs into explicit non-runtime reply rows', async () => {
    const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' };
    await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: 'Lead process reply.',
      source: 'lead_process',
      relayOfMessageId: 'inbound-task-1',
      messageId: 'reply-1',
    });

    const result = await writer.mergeRuntimeDeliveryTaskRefs('my-team', {
      inboxName: 'user',
      messageId: 'reply-1',
      relayOfMessageId: 'inbound-task-1',
      from: 'alice',
      taskRefs: [taskRef],
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(result).toEqual({ found: false, updated: false });
    expect(persisted[0]).not.toHaveProperty('taskRefs');
  });

  it('repairs relayOfMessageId on a runtime delivery reply matched by messageId', async () => {
    const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' };
    await writer.sendMessage('my-team', {
      member: 'user',
      from: 'alice',
      to: 'user',
      text: 'Visible answer.',
      source: 'runtime_delivery',
      relayOfMessageId: 'hallucinated-inbound-id',
      messageId: 'reply-1',
    });

    const result = await writer.correlateRuntimeDeliveryReply('my-team', {
      inboxName: 'user',
      messageId: 'reply-1',
      relayOfMessageId: 'real-inbound-id',
      from: 'alice',
      taskRefs: [taskRef],
    });

    const userInboxPath = '/mock/teams/my-team/inboxes/user.json';
    const persisted = JSON.parse(hoisted.files.get(userInboxPath) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(result).toMatchObject({
      found: true,
      updated: true,
      message: {
        messageId: 'reply-1',
        relayOfMessageId: 'real-inbound-id',
        taskRefs: [taskRef],
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      relayOfMessageId: 'real-inbound-id',
      taskRefs: [taskRef],
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
