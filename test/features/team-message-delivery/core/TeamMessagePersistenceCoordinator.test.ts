import { describe, expect, it, vi } from 'vitest';

import { TeamMessagePersistenceCoordinator } from '../../../../src/features/team-message-delivery/core/application/services/TeamMessagePersistenceCoordinator';

import type {
  ControllerPersistedMessageRequest,
  LeadSentMessageRequest,
  TeamMessageLeadContext,
  TeamMessageLeadMember,
  TeamMessagePersistenceRequest,
  TeamMessagePersistenceResult,
} from '../../../../src/features/team-message-delivery/core/application/ports/TeamMessagePersistencePorts';

const DEFAULT_RESULT: TeamMessagePersistenceResult = {
  deliveredToInbox: true,
  messageId: 'persisted-message',
};

function createHarness() {
  const readLeadContext = vi.fn(
    async (_teamName: string): Promise<TeamMessageLeadContext | null> => ({
      members: [{ name: 'lead-agent', agentType: 'team-lead', role: 'Lead' }],
      leadSessionId: 'lead-session',
    })
  );
  const readMembers = vi.fn(
    async (_teamName: string): Promise<readonly TeamMessageLeadMember[]> => []
  );
  const persistMessage = vi.fn(
    (
      _teamName: string,
      _request: ControllerPersistedMessageRequest
    ): TeamMessagePersistenceResult => DEFAULT_RESULT
  );
  const appendSentMessage = vi.fn(
    (_teamName: string, request: LeadSentMessageRequest): { messageId?: string } => ({
      messageId: request.messageId ?? 'sent-message',
    })
  );
  const sendRuntimeRecipient = vi.fn(
    async (
      _teamName: string,
      _request: TeamMessagePersistenceRequest
    ): Promise<TeamMessagePersistenceResult> => DEFAULT_RESULT
  );
  const invalidate = vi.fn();
  const createMessageId = vi.fn(() => 'generated-message');

  const coordinator = new TeamMessagePersistenceCoordinator({
    leadContext: { readLeadContext },
    memberMeta: { readMembers },
    controllerPersistence: {
      sendMessage: persistMessage,
      appendSentMessage,
    },
    runtimeRecipientInbox: { sendMessage: sendRuntimeRecipient },
    messageFeed: { invalidate },
    identity: { createMessageId },
  });

  return {
    coordinator,
    readLeadContext,
    readMembers,
    persistMessage,
    appendSentMessage,
    sendRuntimeRecipient,
    invalidate,
    createMessageId,
  };
}

describe('TeamMessagePersistenceCoordinator', () => {
  describe('controller message persistence', () => {
    it('enriches session and slash metadata while preserving receiver identity and supported fields', async () => {
      const harness = createHarness();
      const request = {
        member: 'runtime-recipient',
        from: 'lead-agent',
        text: '/compact keep the task context',
        timestamp: '2026-07-29T10:00:00.000Z',
        messageId: 'message-1',
        to: 'durable-recipient',
        color: 'blue',
        conversationId: 'conversation-1',
        replyToConversationId: 'conversation-0',
        toolSummary: '1 tool',
        toolCalls: [{ name: 'Read', preview: 'task.ts', toolUseId: 'tool-1' }],
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: 'intent-1',
        workSyncReviewRequestEventIds: ['review-event-1'],
        commandOutput: { stream: 'stdout', commandLabel: 'compact' },
        taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }],
        actionMode: 'delegate',
        commentId: 'comment-1',
        summary: 'Compact context',
        source: 'system_notification',
        attachments: [
          {
            id: 'attachment-1',
            filename: 'context.txt',
            mimeType: 'text/plain',
            size: 12,
            data: 'Y29udGV4dA==',
          },
        ],
      } satisfies TeamMessagePersistenceRequest;

      await expect(harness.coordinator.sendMessage('my-team', request)).resolves.toEqual(
        DEFAULT_RESULT
      );

      expect(harness.readLeadContext).toHaveBeenCalledWith('my-team');
      expect(harness.persistMessage).toHaveBeenCalledTimes(1);
      const [teamName, persisted] = harness.persistMessage.mock.calls[0]!;
      expect(teamName).toBe('my-team');
      expect(persisted).toEqual({
        member: 'runtime-recipient',
        from: 'lead-agent',
        text: '/compact keep the task context',
        timestamp: '2026-07-29T10:00:00.000Z',
        messageId: 'message-1',
        to: 'durable-recipient',
        color: 'blue',
        conversationId: 'conversation-1',
        replyToConversationId: 'conversation-0',
        toolSummary: '1 tool',
        toolCalls: [{ name: 'Read', preview: 'task.ts', toolUseId: 'tool-1' }],
        messageKind: 'slash_command',
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: 'intent-1',
        workSyncReviewRequestEventIds: ['review-event-1'],
        slashCommand: expect.objectContaining({
          name: 'compact',
          command: '/compact',
          args: 'keep the task context',
        }),
        commandOutput: { stream: 'stdout', commandLabel: 'compact' },
        taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }],
        actionMode: 'delegate',
        commentId: 'comment-1',
        summary: 'Compact context',
        source: 'system_notification',
        leadSessionId: 'lead-session',
        attachments: [
          {
            id: 'attachment-1',
            filename: 'context.txt',
            mimeType: 'text/plain',
            size: 12,
            data: 'Y29udGV4dA==',
          },
        ],
      });
      expect(harness.invalidate).toHaveBeenCalledWith('my-team');
    });

    it('preserves explicit session and slash metadata without reading config', async () => {
      const harness = createHarness();
      const slashCommand = {
        name: 'custom',
        command: '/custom' as const,
        args: 'keep',
      };

      await harness.coordinator.sendMessage('my-team', {
        member: 'alice',
        text: 'not slash-shaped',
        leadSessionId: 'explicit-session',
        messageKind: 'default',
        slashCommand,
      });

      expect(harness.readLeadContext).not.toHaveBeenCalled();
      expect(harness.persistMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          leadSessionId: 'explicit-session',
          messageKind: 'slash_command',
          slashCommand,
        })
      );
    });

    it('persists without session metadata when config reading fails', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockRejectedValueOnce(new Error('config unavailable'));

      await expect(
        harness.coordinator.sendMessage('my-team', {
          member: 'alice',
          text: 'hello',
        })
      ).resolves.toEqual(DEFAULT_RESULT);

      expect(harness.persistMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'alice',
          text: 'hello',
          leadSessionId: undefined,
          slashCommand: undefined,
        })
      );
      expect(harness.invalidate).toHaveBeenCalledWith('my-team');
    });

    it('does not invalidate the feed when controller persistence fails', async () => {
      const harness = createHarness();
      harness.persistMessage.mockImplementationOnce(() => {
        throw new Error('persistence failed');
      });

      await expect(
        harness.coordinator.sendMessage('my-team', {
          member: 'alice',
          text: 'hello',
          leadSessionId: 'explicit-session',
        })
      ).rejects.toThrow('persistence failed');

      expect(harness.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('runtime-recipient persistence', () => {
    it('enriches and sends the complete request through the inbox port before invalidation', async () => {
      const harness = createHarness();
      const order: string[] = [];
      harness.sendRuntimeRecipient.mockImplementationOnce(async (_teamName, request) => {
        order.push(`send:${request.member}`);
        return DEFAULT_RESULT;
      });
      harness.invalidate.mockImplementationOnce((teamName) => {
        order.push(`invalidate:${teamName}`);
      });
      const request = {
        member: 'lead-agent',
        from: 'user',
        text: '/review task-1',
        to: 'runtime-lead',
        taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }],
        attachments: [
          {
            id: 'attachment-1',
            filename: 'review.txt',
            mimeType: 'text/plain',
            size: 6,
            data: 'cmV2aWV3',
          },
        ],
      } satisfies TeamMessagePersistenceRequest;

      await expect(
        harness.coordinator.sendRuntimeRecipientMessage('my-team', request)
      ).resolves.toEqual(DEFAULT_RESULT);

      expect(harness.sendRuntimeRecipient).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'lead-agent',
          from: 'user',
          to: 'runtime-lead',
          taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }],
          attachments: [
            {
              id: 'attachment-1',
              filename: 'review.txt',
              mimeType: 'text/plain',
              size: 6,
              data: 'cmV2aWV3',
            },
          ],
          leadSessionId: 'lead-session',
          messageKind: 'slash_command',
          slashCommand: expect.objectContaining({
            name: 'review',
            command: '/review',
          }),
        })
      );
      expect(order).toEqual(['send:lead-agent', 'invalidate:my-team']);
    });

    it('does not invalidate the feed when inbox persistence rejects', async () => {
      const harness = createHarness();
      harness.sendRuntimeRecipient.mockRejectedValueOnce(new Error('inbox unavailable'));

      await expect(
        harness.coordinator.sendRuntimeRecipientMessage('my-team', {
          member: 'alice',
          text: 'hello',
          leadSessionId: 'explicit-session',
        })
      ).rejects.toThrow('inbox unavailable');

      expect(harness.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('lead-recipient coordination', () => {
    it('persists a system notification to the resolved lead with session metadata and task refs', async () => {
      const harness = createHarness();
      const taskRefs = [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }];

      await expect(
        harness.coordinator.sendSystemNotificationToLead({
          teamName: 'my-team',
          summary: 'Task stalled',
          text: 'Please review task 1.',
          taskRefs,
        })
      ).resolves.toEqual(DEFAULT_RESULT);

      expect(harness.readLeadContext).toHaveBeenCalledTimes(2);
      expect(harness.persistMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'lead-agent',
          from: 'system',
          summary: 'Task stalled',
          text: 'Please review task 1.',
          taskRefs,
          source: 'system_notification',
          leadSessionId: 'lead-session',
        })
      );
    });

    it('uses the compatibility lead and omits empty task refs when config is unavailable', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockRejectedValue(new Error('config unavailable'));

      await harness.coordinator.sendSystemNotificationToLead({
        teamName: 'my-team',
        summary: 'Notice',
        text: 'Fallback notification.',
        taskRefs: [],
      });

      expect(harness.persistMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'team-lead',
          taskRefs: undefined,
          leadSessionId: undefined,
        })
      );
    });

    it('appends a direct lead message with session, slash, attachment, task, and explicit id metadata', async () => {
      const harness = createHarness();
      const attachments = [
        {
          id: 'attachment-1',
          filename: 'plan.md',
          mimeType: 'text/markdown',
          size: 42,
          filePath: '/test/plan.md',
        },
      ];
      const taskRefs = [{ taskId: 'task-1', displayId: '1', teamName: 'my-team' }];

      await expect(
        harness.coordinator.sendDirectToLead(
          'my-team',
          'lead-agent',
          '/compact keep tasks',
          'Compact',
          attachments,
          taskRefs,
          'explicit-message'
        )
      ).resolves.toEqual({
        deliveredToInbox: false,
        deliveredViaStdin: true,
        messageId: 'explicit-message',
      });

      expect(harness.appendSentMessage).toHaveBeenCalledWith('my-team', {
        from: 'user',
        to: 'lead-agent',
        text: '/compact keep tasks',
        taskRefs,
        summary: 'Compact',
        source: 'user_sent',
        attachments,
        leadSessionId: 'lead-session',
        messageKind: 'slash_command',
        slashCommand: expect.objectContaining({
          name: 'compact',
          command: '/compact',
          args: 'keep tasks',
        }),
        messageId: 'explicit-message',
      });
      expect(harness.invalidate).not.toHaveBeenCalled();
      expect(harness.createMessageId).not.toHaveBeenCalled();
    });

    it('appends without optional metadata and generates a result id when durable output lacks one', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockRejectedValueOnce(new Error('config unavailable'));
      harness.appendSentMessage.mockReturnValueOnce({});

      await expect(
        harness.coordinator.sendDirectToLead(
          'my-team',
          'lead-agent',
          'plain text',
          undefined,
          [],
          undefined,
          ''
        )
      ).resolves.toEqual({
        deliveredToInbox: false,
        deliveredViaStdin: true,
        messageId: 'generated-message',
      });

      expect(harness.appendSentMessage).toHaveBeenCalledWith('my-team', {
        from: 'user',
        to: 'lead-agent',
        text: 'plain text',
        taskRefs: undefined,
        summary: undefined,
        source: 'user_sent',
        attachments: undefined,
        leadSessionId: undefined,
      });
      expect(harness.createMessageId).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: 'agent type',
        config: {
          members: [{ name: 'captain', agentType: 'orchestrator' }],
        } as TeamMessageLeadContext,
        expected: 'captain',
      },
      {
        name: 'conventional lead name',
        config: {
          members: [{ name: 'Lead' }],
        } as TeamMessageLeadContext,
        expected: 'Lead',
      },
      {
        name: 'explicit lead role',
        config: {
          members: [{ name: 'captain', role: 'Team Lead' }],
        } as TeamMessageLeadContext,
        expected: 'captain',
      },
      {
        name: 'first-member fallback',
        config: {
          members: [{ name: 'alice', role: 'Engineer' }],
        } as TeamMessageLeadContext,
        expected: 'alice',
      },
      {
        name: 'compatibility fallback',
        config: null,
        expected: 'team-lead',
      },
    ])('resolves lead identity from $name', ({ config, expected }) => {
      const harness = createHarness();

      expect(harness.coordinator.resolveLeadNameFromConfig(config)).toBe(expected);
    });

    it('returns the compatibility lead when asynchronous lead resolution fails', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockRejectedValueOnce(new Error('config unavailable'));

      await expect(harness.coordinator.resolveLeadName('my-team')).resolves.toBe('team-lead');
    });

    it('returns lead runtime context and degrades atomically on config failure', async () => {
      const harness = createHarness();

      await expect(harness.coordinator.resolveLeadRuntimeContext('my-team')).resolves.toEqual({
        leadName: 'lead-agent',
        leadSessionId: 'lead-session',
      });

      harness.readLeadContext.mockRejectedValueOnce(new Error('config unavailable'));
      await expect(harness.coordinator.resolveLeadRuntimeContext('my-team')).resolves.toEqual({
        leadName: 'team-lead',
      });
    });
  });

  describe('durable lead-name lookup', () => {
    it('prefers a recognized config lead without reading member metadata', async () => {
      const harness = createHarness();

      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBe('lead-agent');

      expect(harness.readMembers).not.toHaveBeenCalled();
    });

    it('falls back to the recognized metadata lead', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockResolvedValueOnce({
        members: [{ name: 'alice' }],
      });
      harness.readMembers.mockResolvedValueOnce([
        { name: 'bob' },
        { name: 'captain', agentType: 'team-lead' },
      ]);

      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBe('captain');
    });

    it('falls back to the first metadata member before the first config member', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockResolvedValueOnce({
        members: [{ name: 'config-member' }],
      });
      harness.readMembers.mockResolvedValueOnce([{ name: 'meta-member' }]);

      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBe('meta-member');
    });

    it('uses the first config member when metadata is empty', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockResolvedValueOnce({
        members: [{ name: 'config-member' }],
      });

      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBe('config-member');
    });

    it('returns null when no durable identity exists or a read fails', async () => {
      const harness = createHarness();
      harness.readLeadContext.mockResolvedValueOnce({ members: [] });
      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBeNull();

      harness.readLeadContext.mockRejectedValueOnce(new Error('config unavailable'));
      await expect(harness.coordinator.getLeadMemberName('my-team')).resolves.toBeNull();
      expect(harness.readMembers).toHaveBeenCalledTimes(1);
    });
  });
});
