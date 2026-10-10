import { describe, expect, it, vi } from 'vitest';

import { materializeOpenCodeGroupReply } from '../OpenCodeGroupVisibleReply';
import {
  createOpenCodeVisibleReplyProofServiceFromHost,
  OpenCodeVisibleReplyProofService,
  type OpenCodeVisibleReplyProofServiceDependencies,
  type OpenCodeVisibleReplyProofServiceHost,
} from '../OpenCodeVisibleReplyProofService';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import type { InboxMessage } from '@shared/types/team';

const ISO = '2026-04-25T10:00:03.000Z';

function unexpected(name: string): never {
  throw new Error(`Unexpected OpenCode visible reply proof dependency call: ${name}`);
}

function runtimeReply(
  overrides: Partial<InboxMessage> & { messageId: string; relayOfMessageId: string }
): InboxMessage {
  return {
    from: 'bob',
    to: 'user',
    text: 'Reply.',
    timestamp: ISO,
    read: false,
    source: 'runtime_delivery',
    ...overrides,
  };
}

function makeService(
  options: {
    configuredLeadName?: string | null;
    messagesByInbox?: Record<string, InboxMessage[]>;
  } = {}
): OpenCodeVisibleReplyProofService {
  const messagesByInbox = options.messagesByInbox ?? {};
  const deps = {
    inboxReader: {
      getMessagesFor: vi.fn(
        async (_teamName: string, inboxName: string) => messagesByInbox[inboxName] ?? []
      ),
    },
    inboxWriter: {
      correlateRuntimeDeliveryReply: vi.fn(async () => unexpected('correlateRuntimeDeliveryReply')),
      mergeRuntimeDeliveryTaskRefs: vi.fn(async () => unexpected('mergeRuntimeDeliveryTaskRefs')),
      sendMessage: vi.fn(async () => unexpected('sendMessage')),
    },
    getConfiguredLeadName: vi.fn(async () => options.configuredLeadName ?? null),
    emitRuntimeDeliveryReplyAdvisoryRefresh: vi.fn(),
    warn: vi.fn(),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    nowIso: () => ISO,
  } satisfies OpenCodeVisibleReplyProofServiceDependencies;

  return new OpenCodeVisibleReplyProofService(deps);
}

describe('OpenCodeVisibleReplyProofService', () => {
  it('builds service from host dependencies and resolves configured lead inboxes', async () => {
    const getMessagesFor = vi.fn(async (_teamName: string, inboxName: string) =>
      inboxName === 'captain'
        ? [
            runtimeReply({
              messageId: 'reply-captain',
              relayOfMessageId: 'msg-lead',
              to: 'captain',
            }),
          ]
        : []
    );
    const serviceHost = {
      inboxReader: {
        getMessagesFor,
      },
      inboxWriter: {
        correlateRuntimeDeliveryReply: vi.fn(async () =>
          unexpected('correlateRuntimeDeliveryReply')
        ),
        mergeRuntimeDeliveryTaskRefs: vi.fn(async () => unexpected('mergeRuntimeDeliveryTaskRefs')),
        sendMessage: vi.fn(async () => unexpected('sendMessage')),
      },
      configFacade: {
        readConfigForObservation: vi.fn(async () => ({
          members: [{ name: 'captain', agentType: 'lead' }],
        })),
      },
      emitRuntimeDeliveryReplyAdvisoryRefresh: vi.fn(),
    } satisfies OpenCodeVisibleReplyProofServiceHost;
    const service = createOpenCodeVisibleReplyProofServiceFromHost(serviceHost, {
      warn: vi.fn(),
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      nowIso: () => ISO,
    });

    const proof = await service.findByRelayOfMessageId({
      teamName: 'team-a',
      replyRecipient: 'lead',
      from: 'bob',
      relayOfMessageId: 'msg-lead',
    });

    expect(serviceHost.configFacade.readConfigForObservation).toHaveBeenCalledWith('team-a');
    expect(getMessagesFor).toHaveBeenCalledWith('team-a', 'captain');
    expect(proof?.inboxName).toBe('captain');
    expect(proof?.message.messageId).toBe('reply-captain');
  });

  it('accepts only the originating group canonical reply and never a private or proactive reply', async () => {
    const service = makeService({
      messagesByInbox: {
        user: [
          runtimeReply({ messageId: 'private', relayOfMessageId: 'physical' }),
          runtimeReply({
            messageId: 'other',
            groupMessageId: 'other',
            groupChatId: 'other-group',
            groupChatProtocolVersion: 1,
            relayOfMessageId: 'physical',
          }),
          runtimeReply({
            messageId: 'canonical',
            groupMessageId: 'canonical',
            groupChatId: 'origin-group',
            groupChatProtocolVersion: 1,
            relayOfMessageId: 'physical',
          }),
        ],
      },
    });
    const proof = await service.findByRelayOfMessageId({
      teamName: 'team-a',
      from: 'bob',
      relayOfMessageId: 'physical',
      groupChatId: 'origin-group',
    });
    expect(proof?.message.messageId).toBe('canonical');
    const privateProof = await service.findByRelayOfMessageId({
      teamName: 'team-a',
      from: 'bob',
      relayOfMessageId: 'physical',
    });
    expect(privateProof?.message.messageId).toBe('private');
  });

  it('materializes group plaintext through the facade and settles blocked replies without private fallback', async () => {
    const record = {
      id: 'ledger',
      groupChatId: 'origin',
      inboxMessageId: 'physical',
      observedAssistantPreview: 'Concrete reply',
      responseState: 'responded_plain_text',
      taskRefs: [],
    } as unknown as OpenCodePromptDeliveryLedgerRecord;
    const applyDestinationProof = vi.fn(async () => record);
    const markFailedTerminal = vi.fn(async () => ({
      ...record,
      status: 'failed_terminal' as const,
    }));
    const ledger = {
      applyDestinationProof,
      markFailedTerminal,
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const send = vi.fn(async () => ({
      saved: true as const,
      groupChatId: 'origin',
      messageId: 'reply',
      statusPersisted: true,
    }));
    const input = {
      teamName: 'team-a',
      memberName: 'bob',
      ledger,
      ledgerRecord: record,
      send,
      checkpoint: async () => {},
      messageId: 'reply',
      nowIso: () => ISO,
    };
    const success = await materializeOpenCodeGroupReply(input);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ groupChatId: 'origin', relayOfMessageId: 'physical' })
    );
    expect(success.visibleReply?.message.groupChatId).toBe('origin');
    expect(applyDestinationProof).toHaveBeenCalledTimes(1);
    send.mockRejectedValueOnce(new Error('group_archived'));
    const blocked = await materializeOpenCodeGroupReply(input);
    expect(blocked.visibleReply).toBeNull();
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'group_reply_blocked', diagnostics: ['group_archived'] })
    );
  });

  describe('findByRelayOfMessageId', () => {
    it('accepts exact observed OpenCode user replies for custom configured lead recipients', async () => {
      const service = makeService({
        configuredLeadName: 'captain',
        messagesByInbox: {
          user: [
            runtimeReply({
              text: 'Old reply with the same relay id must not be accepted.',
              timestamp: '2026-04-25T10:00:02.000Z',
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-custom-lead',
            }),
            runtimeReply({
              text: 'Here is the observed answer for the user.',
              messageId: 'reply-user-custom',
              relayOfMessageId: 'msg-custom-lead',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead',
        expectedMessageId: 'reply-user-custom',
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-custom',
          relayOfMessageId: 'msg-custom-lead',
          from: 'bob',
          to: 'user',
        },
        missingRuntimeDeliverySource: false,
      });
    });

    it('uses the exact observed message id for direct OpenCode user replies', async () => {
      const service = makeService({
        configuredLeadName: 'team-lead',
        messagesByInbox: {
          user: [
            runtimeReply({
              text: 'Old duplicate for the same delivery.',
              timestamp: '2026-04-25T10:00:02.000Z',
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-direct-user',
            }),
            runtimeReply({
              text: 'Current observed reply.',
              messageId: 'reply-user-current',
              relayOfMessageId: 'msg-direct-user',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'user',
        from: 'bob',
        relayOfMessageId: 'msg-direct-user',
        expectedMessageId: 'reply-user-current',
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-current',
          relayOfMessageId: 'msg-direct-user',
          from: 'bob',
          to: 'user',
        },
      });
    });

    it('accepts a unique OpenCode user fallback reply when relay correlation has no exact id', async () => {
      const service = makeService({
        configuredLeadName: 'captain',
        messagesByInbox: {
          user: [
            runtimeReply({
              from: 'alice',
              text: 'Different sender should not affect Bob proof.',
              timestamp: '2026-04-25T10:00:01.000Z',
              messageId: 'reply-user-alice',
              relayOfMessageId: 'msg-custom-lead-no-id',
            }),
            runtimeReply({
              text: 'Here is the only Bob reply for this relay.',
              messageId: ' reply-user-single ',
              relayOfMessageId: 'msg-custom-lead-no-id',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-no-id',
        allowUserFallbackForLeadRecipient: true,
      });

      expect(proof).toMatchObject({
        inboxName: 'user',
        message: {
          messageId: 'reply-user-single',
          relayOfMessageId: 'msg-custom-lead-no-id',
          from: 'bob',
          to: 'user',
        },
        missingRuntimeDeliverySource: false,
      });
    });

    it('does not use OpenCode user fallback for lead recipients without confirmed relay correlation', async () => {
      const service = makeService({
        configuredLeadName: 'captain',
        messagesByInbox: {
          user: [
            runtimeReply({
              text: 'This exists, but the caller did not confirm relay correlation.',
              messageId: 'reply-user-single',
              relayOfMessageId: 'msg-custom-lead-no-correlation',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-no-correlation',
      });

      expect(proof).toBeNull();
    });

    it('rejects ambiguous OpenCode user fallback replies when relay correlation has no exact id', async () => {
      const service = makeService({
        configuredLeadName: 'captain',
        messagesByInbox: {
          user: [
            runtimeReply({
              text: 'First candidate.',
              timestamp: '2026-04-25T10:00:02.000Z',
              messageId: 'reply-user-1',
              relayOfMessageId: 'msg-custom-lead-ambiguous',
            }),
            runtimeReply({
              text: 'Second candidate.',
              messageId: 'reply-user-2',
              relayOfMessageId: 'msg-custom-lead-ambiguous',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead-ambiguous',
        allowUserFallbackForLeadRecipient: true,
      });

      expect(proof).toBeNull();
    });

    it('rejects custom lead user fallback replies without the exact observed message id', async () => {
      const service = makeService({
        configuredLeadName: 'captain',
        messagesByInbox: {
          user: [
            runtimeReply({
              text: 'This is not the observed reply for the current delivery.',
              messageId: 'reply-user-stale',
              relayOfMessageId: 'msg-custom-lead',
            }),
          ],
        },
      });

      const proof = await service.findByRelayOfMessageId({
        teamName: 'team-a',
        replyRecipient: 'captain',
        from: 'bob',
        relayOfMessageId: 'msg-custom-lead',
        expectedMessageId: 'reply-user-expected',
      });

      expect(proof).toBeNull();
    });
  });
});
