import { describe, expect, it, vi } from 'vitest';

import { DurableLeadRosterReader } from '../../../../src/features/team-message-delivery/core/application/services/DurableLeadRosterReader';
import { InboxMessageDelivery } from '../../../../src/features/team-message-delivery/core/application/services/InboxMessageDelivery';
import { LiveLeadMessageDelivery } from '../../../../src/features/team-message-delivery/core/application/services/LiveLeadMessageDelivery';

import type { SendTeamMessageCommand } from '../../../../src/features/team-message-delivery/core/application/SendTeamMessageCommand';

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

describe('message delivery services', () => {
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
    const relayOpenCodeMemberInboxMessages = vi.fn(() => {
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
        relayOpenCodeMemberInboxMessages,
        relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
      },
      attachments: { saveAttachments },
      ids: { createMessageId: () => 'generated-id' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      openCodeMonitor: {
        waitForRelay: vi.fn((input) => input.relayPromise),
      } as never,
      openCodeImpact: { buildImpact: () => ({ state: 'none' }) },
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
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith(
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
        relayOpenCodeMemberInboxMessages: vi.fn(),
        relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
      },
      attachments: {
        saveAttachments: vi.fn(() => Promise.reject(errorLike)),
      },
      ids: { createMessageId: () => 'message-1' },
      actionModeInstructions: { buildAgentBlock: () => '' },
      openCodeMonitor: { waitForRelay: vi.fn() } as never,
      openCodeImpact: { buildImpact: () => ({ state: 'none' }) },
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
          recipientProviderId: 'opencode',
        }
      )
    ).rejects.toThrow('Failed to save message attachments: no space');
    expect(sendRuntimeRecipientMessage).not.toHaveBeenCalled();
  });
});
