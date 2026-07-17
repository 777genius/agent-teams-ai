import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeDeliveryPorts,
  type OpenCodeRuntimeDeliveryCrossTeamSender,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import { CROSS_TEAM_SENT_SOURCE } from '../../../../src/shared/constants/crossTeam';

import type { RuntimeDeliveryEnvelope } from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryJournal';
import type { RuntimeDeliveryDestinationPort } from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryService';
import type { CrossTeamSendResult, InboxMessage } from '../../../../src/shared/types/team';

type VoidCrossTeamSender = (
  request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]
) => Promise<void>;

describe('OpenCodeRuntimeDeliveryPorts', () => {
  it('requires exported cross-team senders to return delivery confirmation', () => {
    expectTypeOf<ReturnType<OpenCodeRuntimeDeliveryCrossTeamSender>>().toEqualTypeOf<
      Promise<CrossTeamSendResult>
    >();
    expectTypeOf<VoidCrossTeamSender>().not.toExtend<OpenCodeRuntimeDeliveryCrossTeamSender>();
  });

  it('requires runtime proof when an OpenCode runtime delivers cross-team', async () => {
    const sentMessages: InboxMessage[] = [];
    const crossTeamSender = vi.fn(
      (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) => {
        sentMessages.push({
          from: request.fromMember,
          to: `${request.toTeam}.${request.toMember ?? 'team-lead'}`,
          text: request.text,
          timestamp: request.timestamp ?? '2026-04-21T12:00:00.000Z',
          read: true,
          messageId: request.messageId ?? 'runtime-delivery-message',
          source: CROSS_TEAM_SENT_SOURCE,
        });
        return Promise.resolve({
          messageId: request.messageId ?? 'runtime-delivery-message',
          deliveredToInbox: true,
        });
      }
    );
    const port = getCrossTeamPort(
      createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(() => Promise.resolve()),
          readMessages: vi.fn(() => Promise.resolve(sentMessages)),
        },
        inboxReader: {
          getMessagesFor: vi.fn(() => Promise.resolve([])),
        },
        inboxWriter: {
          sendMessage: vi.fn(() =>
            Promise.resolve({
              deliveredToInbox: true,
              messageId: 'unused',
            })
          ),
        },
        getCrossTeamSender: () => crossTeamSender,
      })
    );

    const location = await port.write({
      envelope: envelope(),
      destinationMessageId: 'runtime-delivery-message',
    });

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'team-a',
        fromMember: 'Builder',
        toTeam: 'team-b',
        toMember: 'Reviewer',
        messageId: 'runtime-delivery-message',
        requireRuntimeDelivery: true,
      })
    );
    expect(location).toEqual({
      kind: 'cross_team_outbox',
      fromTeamName: 'team-a',
      toTeamName: 'team-b',
      toMemberName: 'Reviewer',
      messageId: 'runtime-delivery-message',
    });
    await expect(
      port.verify({
        destination: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
        },
        destinationMessageId: 'runtime-delivery-message',
      })
    ).resolves.toMatchObject({
      found: false,
      diagnostics: ['cross-team target runtime proof required'],
    });
    await expect(
      port.verify({
        destination: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
        },
        destinationMessageId: 'runtime-delivery-message',
        location,
      })
    ).resolves.toMatchObject({ found: true });
  });

  it('does not treat a sender copy as cross-team runtime proof without a write result', async () => {
    const sentMessages: InboxMessage[] = [
      {
        from: 'Builder',
        to: 'team-b.Reviewer',
        text: 'Please review this',
        timestamp: '2026-04-21T12:00:00.000Z',
        read: true,
        messageId: 'runtime-delivery-message',
        source: CROSS_TEAM_SENT_SOURCE,
      },
    ];
    const port = getCrossTeamPort(
      createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(() => Promise.resolve()),
          readMessages: vi.fn(() => Promise.resolve(sentMessages)),
        },
        inboxReader: {
          getMessagesFor: vi.fn(() => Promise.resolve([])),
        },
        inboxWriter: {
          sendMessage: vi.fn(() =>
            Promise.resolve({
              deliveredToInbox: true,
              messageId: 'unused',
            })
          ),
        },
        getCrossTeamSender: () => vi.fn(),
      })
    );

    await expect(
      port.verify({
        destination: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
        },
        destinationMessageId: 'runtime-delivery-message',
      })
    ).resolves.toMatchObject({
      found: false,
      location: null,
      diagnostics: ['cross-team target runtime proof required'],
    });
  });

  it('repairs missing sender-copy proof after live cross-team delivery succeeds', async () => {
    const sentMessages: InboxMessage[] = [];
    const appendMessage = vi.fn((_teamName: string, message: InboxMessage) => {
      sentMessages.push(message);
      return Promise.resolve();
    });
    const deliveredMessageId = 'deduplicated-runtime-cross-team-message';
    const crossTeamSender = vi.fn(
      (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) =>
        Promise.resolve({
          messageId: deliveredMessageId,
          deliveredToInbox: true,
          deduplicated: true,
          toTeam: request.toTeam,
          toMember: request.toMember,
        })
    );
    const port = getCrossTeamPort(
      createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage,
          readMessages: vi.fn(() => Promise.resolve(sentMessages)),
        },
        inboxReader: {
          getMessagesFor: vi.fn(() => Promise.resolve([])),
        },
        inboxWriter: {
          sendMessage: vi.fn(() =>
            Promise.resolve({
              deliveredToInbox: true,
              messageId: 'unused',
            })
          ),
        },
        getCrossTeamSender: () => crossTeamSender,
      })
    );

    const location = await port.write({
      envelope: envelope(),
      destinationMessageId: 'runtime-delivery-message',
    });

    expect(appendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        from: 'Builder',
        to: 'team-b.Reviewer',
        text: 'Please review this',
        messageId: deliveredMessageId,
        source: CROSS_TEAM_SENT_SOURCE,
      })
    );
    expect(location).toMatchObject({
      messageId: deliveredMessageId,
    });
    await expect(
      port.verify({
        destination: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
        },
        destinationMessageId: 'runtime-delivery-message',
        location,
      })
    ).resolves.toMatchObject({ found: true });
  });
});

function getCrossTeamPort(ports: RuntimeDeliveryDestinationPort[]): RuntimeDeliveryDestinationPort {
  const port = ports.find((candidate) => candidate.kind === 'cross_team_outbox');
  if (!port) {
    throw new Error('cross-team runtime delivery port not registered');
  }
  return port;
}

function envelope(): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'delivery-1',
    runId: 'run-1',
    teamName: 'team-a',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: { teamName: 'team-b', memberName: 'Reviewer' },
    text: 'Please review this',
    createdAt: '2026-04-21T12:00:00.000Z',
  };
}
