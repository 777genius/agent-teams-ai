import { describe, expect, it, vi } from 'vitest';

import { DurableLeadRosterReader } from '../../../../src/features/team-message-delivery/core/application/services/DurableLeadRosterReader';
import { InboxMessageDelivery } from '../../../../src/features/team-message-delivery/core/application/services/InboxMessageDelivery';
import { LiveLeadMessageDelivery } from '../../../../src/features/team-message-delivery/core/application/services/LiveLeadMessageDelivery';
import { SendTeamMessageUseCase } from '../../../../src/features/team-message-delivery/core/application/use-cases/SendTeamMessageUseCase';
import { buildMessageDeliveryText } from '../../../../src/features/team-message-delivery/core/domain/leadMessagePresentation';

import type { SendTeamMessageCommand } from '../../../../src/features/team-message-delivery/core/application/SendTeamMessageCommand';
import type { SendMessageRequest, TeamProviderId } from '../../../../src/shared/types';

const command: SendTeamMessageCommand = {
  teamName: 'demo-team',
  memberName: 'team-lead',
  text: 'Please review this',
  summary: 'Review',
  taskRefs: [{ taskId: 'task-1', displayId: 'TASK-1', teamName: 'demo-team' }],
};

function logger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function messageCompatibility(
  protocol: 'send_message' | 'agent_teams_message_send' = 'send_message'
) {
  return {
    requiresGeneratedMessageId: () => protocol === 'agent_teams_message_send',
    buildRecipientDeliveryText: (
      input: Parameters<typeof buildMessageDeliveryText>[1] & { baseText: string }
    ) =>
      buildMessageDeliveryText(input.baseText, {
        ...input,
        protocol,
      }),
    buildMissingDelivery: (relay: { relayed: number }) => ({
      delivered: relay.relayed > 0,
    }),
    formatWarning: () => null,
  };
}

describe('message delivery services', () => {
  it.each([
    ['codex' as const, false],
    ['opencode' as const, true],
    ['anthropic' as const, false],
    [undefined, false],
  ])(
    'preserves %s provider identity separately from runtime delivery capability',
    async (recipientProviderId, requiresRuntimeDelivery) => {
      const inboxDeliver = vi.fn(() =>
        Promise.resolve({ deliveredToInbox: true, messageId: 'message-1' })
      );
      const delivery = new SendTeamMessageUseCase({
        leadRecipient: {
          getLeadMemberName: vi.fn(() => Promise.resolve('team-lead')),
        },
        runtime: { isTeamAlive: vi.fn(() => true) },
        messaging: {
          resolveRecipientRoute: vi.fn(() =>
            Promise.resolve({
              ...(recipientProviderId ? { providerId: recipientProviderId as TeamProviderId } : {}),
              requiresRuntimeDelivery,
            })
          ),
        },
        compatibility: {
          attachmentSupportError: () => 'attachments unsupported',
        },
        liveLeadDelivery: { deliver: vi.fn() } as never,
        inboxDelivery: { deliver: inboxDeliver } as never,
      });
      const workerCommand = { ...command, memberName: 'worker' };

      await expect(delivery.execute(workerCommand, null)).resolves.toEqual({
        deliveredToInbox: true,
        messageId: 'message-1',
      });
      expect(inboxDeliver).toHaveBeenCalledWith(workerCommand, {
        isLeadRecipient: false,
        isTeamAlive: true,
        requiresRuntimeDelivery,
        ...(recipientProviderId ? { recipientProviderId } : {}),
      });
    }
  );

  it.each([
    {
      label: 'Codex',
      providerId: 'codex' as const,
      expectedProtocol: 'agent-teams_message_send',
      expectsCorrelation: true,
    },
    {
      label: 'legacy Anthropic',
      providerId: 'anthropic' as const,
      expectedProtocol: 'Reply using the SendMessage tool',
      expectsCorrelation: false,
    },
    {
      label: 'unknown legacy',
      providerId: undefined,
      expectedProtocol: 'Reply using the SendMessage tool',
      expectsCorrelation: false,
    },
  ])(
    'honors the $label compatibility protocol for visible UI replies',
    async ({ providerId, expectedProtocol, expectsCorrelation }) => {
      const result = { deliveredToInbox: true, messageId: 'stored-message-id' };
      const sendMessage = vi.fn((_teamName: string, _request: SendMessageRequest) =>
        Promise.resolve(result)
      );
      const sendRuntimeRecipientMessage = vi.fn();
      const delivery = new InboxMessageDelivery({
        persistence: { sendMessage, sendRuntimeRecipientMessage },
        messaging: {
          relayRuntimeRecipientInboxMessages: vi.fn(),
          relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
        },
        attachments: { saveAttachments: vi.fn() },
        ids: { createMessageId: () => 'correlation-id' },
        actionModeInstructions: { buildAgentBlock: () => '' },
        runtimeDeliveryMonitor: { waitForRelay: vi.fn() } as never,
        runtimeDeliveryImpact: { buildImpact: () => ({ state: 'none' }) },
        compatibility: messageCompatibility(
          expectsCorrelation ? 'agent_teams_message_send' : 'send_message'
        ),
        logger: logger(),
      });

      await expect(
        delivery.deliver(
          {
            ...command,
            memberName: 'worker',
            from: ' User ',
          },
          {
            isLeadRecipient: false,
            isTeamAlive: true,
            requiresRuntimeDelivery: false,
            ...(providerId ? { recipientProviderId: providerId } : {}),
          }
        )
      ).resolves.toBe(result);

      expect(sendRuntimeRecipientMessage).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();
      const request = sendMessage.mock.calls[0]?.[1];
      expect(request?.from).toBe('user');
      expect(request?.text).toContain(expectedProtocol);
      if (expectsCorrelation) {
        expect(request?.messageId).toBe('correlation-id');
        expect(request?.text).toContain('source="runtime_delivery"');
        expect(request?.text).toContain('relayOfMessageId="correlation-id"');
      } else {
        expect(request).not.toHaveProperty('messageId');
        expect(request?.text).not.toContain('agent-teams_message_send');
      }
    }
  );

  it('keeps live lead side effects in stdin, attachment, persistence, projection order', async () => {
    const order: string[] = [];
    const attachments = [
      {
        id: 'att-1',
        filename: 'image.png',
        mimeType: 'image/png',
        size: 3,
        data: 'AAAA',
      },
    ];
    const delivery = new LiveLeadMessageDelivery({
      roster: new DurableLeadRosterReader({
        roster: {
          getMembers: vi.fn(() => Promise.resolve([{ name: 'worker', role: 'Developer' }])),
          getFallbackMembers: vi.fn(() => Promise.resolve([])),
        },
        logger: logger(),
      }),
      persistence: {
        sendDirectToLead: vi.fn(() => {
          order.push('persist');
          return Promise.resolve({ deliveredToInbox: false, messageId: 'message-1' });
        }),
      },
      messaging: {
        sendMessageToTeam: vi.fn(() => {
          order.push('stdin');
          return Promise.resolve();
        }),
        pushLiveLeadProcessMessage: vi.fn(() => order.push('projection')),
      },
      runtime: { isTeamAlive: vi.fn(() => true) },
      attachments: {
        saveAttachments: vi.fn(() => {
          order.push('attachments');
          return Promise.resolve(new Map([['att-1', '/workspace/image.png']]));
        }),
      },
      ids: { createMessageId: () => 'message-1' },
      clock: { nowIso: () => '2026-07-23T00:00:00.000Z' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      logger: logger(),
    });

    await expect(delivery.deliver({ ...command, attachments }, 'team-lead')).resolves.toEqual({
      deliveredToInbox: false,
      messageId: 'message-1',
    });
    expect(order).toEqual(['stdin', 'attachments', 'persist', 'projection']);
  });

  it('does not fall back after stdin succeeds and persistence fails', async () => {
    const pushLiveLeadProcessMessage = vi.fn();
    const log = logger();
    const delivery = new LiveLeadMessageDelivery({
      roster: new DurableLeadRosterReader({
        roster: {
          getMembers: vi.fn(() => Promise.resolve([])),
          getFallbackMembers: vi.fn(() => Promise.resolve([])),
        },
        logger: log,
      }),
      persistence: {
        sendDirectToLead: vi.fn(() => Promise.reject(new Error('disk failed'))),
      },
      messaging: {
        sendMessageToTeam: vi.fn(() => Promise.resolve()),
        pushLiveLeadProcessMessage,
      },
      runtime: { isTeamAlive: vi.fn(() => true) },
      attachments: { saveAttachments: vi.fn(() => Promise.resolve(new Map())) },
      ids: { createMessageId: () => 'stable-id' },
      clock: { nowIso: () => '2026-07-23T00:00:00.000Z' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      logger: log,
    });

    await expect(delivery.deliver(command, 'team-lead')).resolves.toEqual({
      deliveredToInbox: false,
      messageId: 'stable-id',
    });
    expect(pushLiveLeadProcessMessage).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'Persistence failed after stdin delivery for demo-team: Error: disk failed'
    );
  });

  it('falls through to inbox only when stdin fails without attachments', async () => {
    const delivery = new LiveLeadMessageDelivery({
      roster: new DurableLeadRosterReader({
        roster: {
          getMembers: vi.fn(() => Promise.resolve([])),
          getFallbackMembers: vi.fn(() => Promise.resolve([])),
        },
        logger: logger(),
      }),
      persistence: { sendDirectToLead: vi.fn() },
      messaging: {
        sendMessageToTeam: vi.fn(() => Promise.reject(new Error('stdin closed'))),
        pushLiveLeadProcessMessage: vi.fn(),
      },
      runtime: { isTeamAlive: vi.fn(() => true) },
      attachments: { saveAttachments: vi.fn(() => Promise.resolve(new Map())) },
      ids: { createMessageId: () => 'message-1' },
      clock: { nowIso: () => '2026-07-23T00:00:00.000Z' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      logger: logger(),
    });

    await expect(delivery.deliver(command, 'team-lead')).resolves.toBeNull();
  });

  it('saves OpenCode attachments with the generated id before persistence and relay', async () => {
    const order: string[] = [];
    const result = { deliveredToInbox: true, messageId: 'generated-id' };
    const relayRuntimeRecipientInboxMessages = vi.fn(() => {
      order.push('relay');
      return Promise.resolve({ relayed: 1, attempted: 1, delivered: 1, failed: 0 });
    });
    const saveAttachments = vi.fn(() => {
      order.push('attachments');
      return Promise.resolve(new Map());
    });
    const sendRuntimeRecipientMessage = vi.fn(() => {
      order.push('persist');
      return Promise.resolve(result);
    });
    const delivery = new InboxMessageDelivery({
      persistence: {
        sendMessage: vi.fn(),
        sendRuntimeRecipientMessage,
      },
      messaging: {
        relayRuntimeRecipientInboxMessages,
        relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
      },
      attachments: { saveAttachments },
      ids: { createMessageId: () => 'generated-id' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      runtimeDeliveryMonitor: {
        waitForRelay: vi.fn((input) => input.relayPromise),
      } as never,
      runtimeDeliveryImpact: { buildImpact: () => ({ state: 'none' }) },
      compatibility: messageCompatibility(),
      logger: logger(),
    });

    const returned = await delivery.deliver(
      {
        ...command,
        memberName: 'worker',
        attachments: [
          {
            id: 'att-1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            size: 3,
            data: 'YQ==',
          },
        ],
      },
      {
        isLeadRecipient: false,
        isTeamAlive: true,
        requiresRuntimeDelivery: true,
        recipientProviderId: 'opencode',
      }
    );

    expect(returned).toBe(result);
    expect(order).toEqual(['attachments', 'persist', 'relay']);
    expect(saveAttachments).toHaveBeenCalledWith('demo-team', 'generated-id', [
      expect.objectContaining({ id: 'att-1' }),
    ]);
    expect(sendRuntimeRecipientMessage).toHaveBeenCalledWith(
      'demo-team',
      expect.objectContaining({ messageId: 'generated-id' })
    );
    expect(relayRuntimeRecipientInboxMessages).toHaveBeenCalledWith(
      'demo-team',
      'worker',
      expect.objectContaining({ onlyMessageId: 'generated-id' })
    );
    expect(returned.runtimeDelivery).toMatchObject({
      providerId: 'opencode',
      attempted: true,
      delivered: true,
    });
  });

  it('fails closed when inbox attachment persistence fails', async () => {
    const sendRuntimeRecipientMessage = vi.fn();
    const errorLike = new Error('no space');
    Object.setPrototypeOf(errorLike, Object.prototype);
    const delivery = new InboxMessageDelivery({
      persistence: { sendMessage: vi.fn(), sendRuntimeRecipientMessage },
      messaging: {
        relayRuntimeRecipientInboxMessages: vi.fn(),
        relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
      },
      attachments: {
        saveAttachments: vi.fn(() => Promise.reject(errorLike)),
      },
      ids: { createMessageId: () => 'message-1' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      runtimeDeliveryMonitor: { waitForRelay: vi.fn() } as never,
      runtimeDeliveryImpact: { buildImpact: () => ({ state: 'none' }) },
      compatibility: messageCompatibility(),
      logger: logger(),
    });

    await expect(
      delivery.deliver(
        {
          ...command,
          memberName: 'worker',
          attachments: [
            {
              id: 'att-1',
              filename: 'image.png',
              mimeType: 'image/png',
              size: 3,
              data: 'AAAA',
            },
          ],
        },
        {
          isLeadRecipient: false,
          isTeamAlive: true,
          requiresRuntimeDelivery: true,
          recipientProviderId: 'opencode',
        }
      )
    ).rejects.toThrow('Failed to save message attachments: no space');
    expect(sendRuntimeRecipientMessage).not.toHaveBeenCalled();
  });
});
