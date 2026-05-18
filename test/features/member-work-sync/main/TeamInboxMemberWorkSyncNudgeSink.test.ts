import { describe, expect, it, vi } from 'vitest';

import { TeamInboxMemberWorkSyncNudgeSink } from '@features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink';

import type { MemberWorkSyncInboxNudgePort } from '@features/member-work-sync/core/application';

type NudgeInput = Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0];

function makeInput(overrides: Partial<NudgeInput> = {}): NudgeInput {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    messageId: 'member-work-sync:team-a:bob:agenda-v1-test',
    payloadHash: 'payload-hash',
    timestamp: '2026-04-29T00:00:00.000Z',
    payload: {
      from: 'system',
      to: 'bob',
      messageKind: 'member_work_sync_nudge',
      source: 'member-work-sync',
      actionMode: 'do',
      workSyncIntent: 'agenda_sync',
      text: 'Please reconcile your current work state.',
      taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
    },
    ...overrides,
  };
}

describe('TeamInboxMemberWorkSyncNudgeSink', () => {
  it('returns inserted=false when the inbox already contains the stable messageId', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        { messageId: input.messageId, workSyncPayloadHash: input.payloadHash },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
    });

    expect(inboxReader.getMessagesFor).toHaveBeenCalledWith('team-a', 'bob');
    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the existing stable messageId has a different payload hash', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        { messageId: input.messageId, workSyncPayloadHash: 'different-payload-hash' },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
      conflict: true,
    });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('treats legacy work-sync rows without payload hash as conflicts', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: input.payload.workSyncIntent,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
      conflict: true,
    });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('writes a system notification inbox message for a new nudge', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ messageId: input.messageId })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: true,
      messageId: input.messageId,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledWith('team-a', {
      member: 'bob',
      from: 'system',
      to: 'bob',
      messageId: input.messageId,
      timestamp: input.timestamp,
      text: input.payload.text,
      taskRefs: input.payload.taskRefs,
      actionMode: 'do',
      summary: 'Work sync check',
      source: 'system_notification',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'agenda_sync',
      workSyncIntentKey: undefined,
      workSyncReviewRequestEventIds: undefined,
      workSyncPayloadHash: input.payloadHash,
    });
  });

  it('propagates reader failures so dispatch can classify the attempt', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => {
        throw new Error('reader failed');
      }),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).rejects.toThrow('reader failed');
    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('propagates writer failures so dispatch can retry or mark terminal', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(async () => {
        throw new Error('writer failed');
      }),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(sink.insertIfAbsent(input)).rejects.toThrow('writer failed');
  });
});
