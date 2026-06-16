import { TeamInboxMemberWorkSyncNudgeSink } from '@features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink';
import { describe, expect, it, vi } from 'vitest';

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
        {
          messageId: input.messageId,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
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
    });

    expect(inboxReader.getMessagesFor).toHaveBeenCalledWith('team-a', 'bob');
    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('repairs an existing idempotent nudge row that is missing the current controlUrl', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(async () => ({ found: true, updated: true })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
    });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).toHaveBeenCalledWith('team-a', {
      member: 'bob',
      messageId: input.messageId,
      text: `${input.payload.text}\nRequired control API: pass controlUrl "http://127.0.0.1:43123" in both member_work_sync_status and member_work_sync_report.`,
      expectedMessageKind: 'member_work_sync_nudge',
      expectedWorkSyncPayloadHash: input.payloadHash,
    });
  });

  it('refreshes a stale controlUrl on an existing idempotent nudge row', async () => {
    const input = makeInput();
    const existingText = `${input.payload.text}\nRequired control API: pass controlUrl "http://127.0.0.1:11111" in both member_work_sync_status and member_work_sync_report.`;
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: existingText,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(async () => ({ found: true, updated: true })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
    });

    expect(inboxWriter.updateMessageText).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        text: `${input.payload.text}\nRequired control API: pass controlUrl "http://127.0.0.1:43123" in both member_work_sync_status and member_work_sync_report.`,
      })
    );
  });

  it('fails closed when an existing idempotent nudge needs controlUrl repair but resolver is unavailable', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => null
    );

    await expect(sink.insertIfAbsent(input)).rejects.toThrow(
      'member work sync control URL unavailable'
    );

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).not.toHaveBeenCalled();
  });

  it('fails closed when an existing idempotent nudge needs controlUrl repair but writer cannot update text', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(sink.insertIfAbsent(input)).rejects.toThrow(
      'member work sync inbox text update unavailable'
    );

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('repairs a delivered nudge row by stable messageId without inserting a duplicate', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(async () => ({ found: true, updated: true })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(
      sink.repairIfPresent({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        payload: input.payload,
      })
    ).resolves.toEqual({ found: true, repaired: true });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        messageId: input.messageId,
        expectedWorkSyncPayloadHash: input.payloadHash,
      })
    );
  });

  it('reports direct repair as unrepaired when the guarded writer refuses the update', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(async () => ({ found: true, updated: false })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(
      sink.repairIfPresent({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        payload: input.payload,
      })
    ).resolves.toEqual({ found: true, repaired: false });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        messageId: input.messageId,
        expectedWorkSyncPayloadHash: input.payloadHash,
      })
    );
  });

  it('reports missing delivered rows during direct repair without inserting', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(
      sink.repairIfPresent({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        payload: input.payload,
      })
    ).resolves.toEqual({ found: false, repaired: false });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).not.toHaveBeenCalled();
  });

  it('fails closed when direct repair finds a different payload hash', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: input.payload.text,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: 'different-payload-hash',
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(inboxReader as never, inboxWriter as never);

    await expect(
      sink.repairIfPresent({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        payload: input.payload,
      })
    ).resolves.toEqual({ found: true, repaired: false, conflict: true });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).not.toHaveBeenCalled();
  });

  it('does not rewrite an existing idempotent nudge row with the current controlUrl', async () => {
    const input = makeInput();
    const existingText = `${input.payload.text}\nRequired control API: pass controlUrl "http://127.0.0.1:43123" in both member_work_sync_status and member_work_sync_report.`;
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          text: existingText,
          messageKind: 'member_work_sync_nudge',
          workSyncPayloadHash: input.payloadHash,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(async () => ({ found: true, updated: true })),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
    });

    expect(inboxWriter.updateMessageText).not.toHaveBeenCalled();
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

  it('fails closed when the existing stable messageId is not a work-sync nudge row', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => [
        {
          messageId: input.messageId,
          messageKind: 'task_comment_notification',
          workSyncPayloadHash: input.payloadHash,
          text: input.payload.text,
        },
      ]),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
      updateMessageText: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => 'http://127.0.0.1:43123'
    );

    await expect(sink.insertIfAbsent(input)).resolves.toEqual({
      inserted: false,
      messageId: input.messageId,
      conflict: true,
    });

    await expect(
      sink.repairIfPresent({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        payload: input.payload,
      })
    ).resolves.toEqual({ found: true, repaired: false, conflict: true });

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(inboxWriter.updateMessageText).not.toHaveBeenCalled();
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

  it('does not insert a new nudge when a configured controlUrl resolver returns null', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => null
    );

    await expect(sink.insertIfAbsent(input)).rejects.toThrow(
      'member work sync control URL unavailable'
    );

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
  });

  it('does not insert a new nudge when a configured controlUrl resolver fails', async () => {
    const input = makeInput();
    const inboxReader = {
      getMessagesFor: vi.fn(async () => []),
    };
    const inboxWriter = {
      sendMessage: vi.fn(),
    };
    const sink = new TeamInboxMemberWorkSyncNudgeSink(
      inboxReader as never,
      inboxWriter as never,
      () => {
        throw new Error('sidecar failed');
      }
    );

    await expect(sink.insertIfAbsent(input)).rejects.toThrow(
      'member work sync control URL unavailable'
    );

    expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
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
