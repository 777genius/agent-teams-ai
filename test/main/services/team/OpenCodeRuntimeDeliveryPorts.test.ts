import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeDeliveryPorts,
  type OpenCodeRuntimeDeliveryCrossTeamSender,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  type RuntimeDeliveryEnvelope,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryJournal';
import {
  type RuntimeDeliveryDestinationPort,
  RuntimeDeliveryDestinationRegistry,
  RuntimeDeliveryService,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryService';
import { CROSS_TEAM_SENT_SOURCE } from '../../../../src/shared/constants/crossTeam';

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

  it('normalizes mixed legacy and structured task refs for every destination', async () => {
    const sentMessages: InboxMessage[] = [];
    const appendMessage = vi.fn((_teamName: string, message: InboxMessage) => {
      sentMessages.push(message);
      return Promise.resolve();
    });
    const sendMessage = vi.fn(() =>
      Promise.resolve({ deliveredToInbox: true, messageId: 'member-task-refs' })
    );
    const crossTeamSender = vi.fn(
      (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) =>
        Promise.resolve({
          messageId: request.messageId ?? 'cross-team-task-refs',
          deliveredToInbox: true,
        })
    );
    const ports = createOpenCodeRuntimeDeliveryPorts({
      sentMessagesStore: {
        appendMessage,
        readMessages: vi.fn(() => Promise.resolve(sentMessages)),
      },
      inboxReader: {
        getMessagesFor: vi.fn(() => Promise.resolve([])),
      },
      inboxWriter: { sendMessage },
      getCrossTeamSender: () => crossTeamSender,
    });
    const structuredTaskRef = {
      taskId: ' structured-task-id ',
      displayId: ' #structured ',
      teamName: ' exact-runtime-team ',
    };
    const taskRefs = [
      ' legacy-task-id ',
      structuredTaskRef,
      '',
      '   ',
      null,
      42,
      {},
      { taskId: 'partial-task-ref' },
      { taskId: '', displayId: '#invalid', teamName: 'team-a' },
      ['nested-task-ref'],
    ] as unknown as RuntimeDeliveryEnvelope['taskRefs'];
    const expectedTaskRefs = [
      {
        taskId: 'legacy-task-id',
        displayId: 'legacy-task-id',
        teamName: 'team-a',
      },
      structuredTaskRef,
    ];

    await getRuntimePort(ports, 'user_sent_messages').write({
      envelope: { ...envelope(), to: 'user', taskRefs },
      destinationMessageId: 'user-task-refs',
    });
    await getRuntimePort(ports, 'member_inbox').write({
      envelope: { ...envelope(), to: { memberName: 'Reviewer' }, taskRefs },
      destinationMessageId: 'member-task-refs',
    });
    await getRuntimePort(ports, 'cross_team_outbox').write({
      envelope: { ...envelope(), taskRefs },
      destinationMessageId: 'cross-team-task-refs',
    });

    expect(appendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        messageId: 'user-task-refs',
        taskRefs: expectedTaskRefs,
      })
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ taskRefs: expectedTaskRefs })
    );
    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({ taskRefs: expectedTaskRefs })
    );
    expect(appendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        messageId: 'cross-team-task-refs',
        taskRefs: expectedTaskRefs,
      })
    );
  });

  it('omits task refs when persisted refs are empty or malformed', async () => {
    const emptyTaskRefValues = [
      [],
      ['', '   ', null, 42, {}, { taskId: 'partial-task-ref' }, ['nested-task-ref']],
      null,
      {},
      'not-an-array',
    ];

    for (const taskRefValue of emptyTaskRefValues) {
      const appendMessage = vi.fn(() => Promise.resolve());
      const crossTeamSender = vi.fn(
        (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) =>
          Promise.resolve({
            messageId: request.messageId ?? 'runtime-delivery-message',
            deliveredToInbox: true,
          })
      );
      const port = getCrossTeamPort(
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage,
            readMessages: vi.fn(() => Promise.resolve([])),
          },
          inboxReader: {
            getMessagesFor: vi.fn(() => Promise.resolve([])),
          },
          inboxWriter: {
            sendMessage: vi.fn(() =>
              Promise.resolve({ deliveredToInbox: true, messageId: 'unused' })
            ),
          },
          getCrossTeamSender: () => crossTeamSender,
        })
      );

      await port.write({
        envelope: {
          ...envelope(),
          taskRefs: taskRefValue as unknown as RuntimeDeliveryEnvelope['taskRefs'],
        },
        destinationMessageId: 'runtime-delivery-message',
      });

      expect(crossTeamSender).toHaveBeenCalledTimes(1);
      expect(crossTeamSender.mock.calls[0]?.[0]).not.toHaveProperty('taskRefs');
      expect(appendMessage).toHaveBeenCalledWith(
        'team-a',
        expect.objectContaining({ taskRefs: undefined })
      );
    }
  });

  it('requires explicit target-runtime proof even when an exact sender copy exists', async () => {
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
    ).resolves.toEqual({
      found: false,
      location: null,
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

  it('repeats target-runtime delivery after markCommitted crashes instead of trusting sender copy', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'cross-team-delivery-recovery-'));
    try {
      const sentMessages: InboxMessage[] = [];
      const crossTeamSender = vi.fn(
        (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) => {
          const messageId = request.messageId ?? 'runtime-delivery-message';
          const deduplicated = sentMessages.some((message) => message.messageId === messageId);
          if (!deduplicated) {
            sentMessages.push({
              from: request.fromMember,
              to: `${request.toTeam}.${request.toMember ?? 'team-lead'}`,
              text: request.text,
              timestamp: request.timestamp ?? '2026-04-21T12:00:00.000Z',
              read: true,
              messageId,
              source: CROSS_TEAM_SENT_SOURCE,
            });
          }
          return Promise.resolve({
            messageId,
            deliveredToInbox: true,
            deduplicated,
            toTeam: request.toTeam,
            toMember: request.toMember,
          });
        }
      );
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn((_teamName: string, message: InboxMessage) => {
            sentMessages.push(message);
            return Promise.resolve();
          }),
          readMessages: vi.fn(() => Promise.resolve(sentMessages)),
        },
        inboxReader: {
          getMessagesFor: vi.fn(() => Promise.resolve([])),
        },
        inboxWriter: {
          sendMessage: vi.fn(() =>
            Promise.resolve({ deliveredToInbox: true, messageId: 'unused' })
          ),
        },
        getCrossTeamSender: () => crossTeamSender,
      });
      const journal = createRuntimeDeliveryJournalStore({
        filePath: join(journalDir, 'delivery-journal.json'),
        clock: () => new Date('2026-04-21T12:00:00.000Z'),
      });
      vi.spyOn(journal, 'markCommitted').mockRejectedValueOnce(
        new Error('simulated crash before markCommitted')
      );
      const service = new RuntimeDeliveryService(
        { getCurrentRunId: vi.fn(() => Promise.resolve('run-1')) },
        journal,
        new RuntimeDeliveryDestinationRegistry(ports),
        { append: vi.fn(() => Promise.resolve()) },
        { emit: vi.fn() },
        () => new Date('2026-04-21T12:00:00.000Z')
      );
      const deliveryEnvelope = envelope();
      const destinationMessageId = buildRuntimeDestinationMessageId(deliveryEnvelope);

      await expect(service.deliver(deliveryEnvelope)).rejects.toThrow(
        'simulated crash before markCommitted'
      );
      await expect(
        journal.get({ idempotencyKey: 'delivery-1', runId: 'run-1', teamName: 'team-a' })
      ).resolves.toMatchObject({
        status: 'failed_retryable',
        committedLocation: null,
      });

      await expect(service.deliver(deliveryEnvelope)).resolves.toMatchObject({
        ok: true,
        delivered: true,
        reason: null,
        location: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
          messageId: destinationMessageId,
        },
      });
      expect(crossTeamSender).toHaveBeenCalledTimes(2);
      expect(sentMessages).toEqual([
        expect.objectContaining({
          to: 'team-b.Reviewer',
          messageId: destinationMessageId,
        }),
      ]);
      await expect(
        journal.get({ idempotencyKey: 'delivery-1', runId: 'run-1', teamName: 'team-a' })
      ).resolves.toMatchObject({
        status: 'committed',
        committedLocation: {
          kind: 'cross_team_outbox',
          fromTeamName: 'team-a',
          toTeamName: 'team-b',
          toMemberName: 'Reviewer',
          messageId: destinationMessageId,
        },
      });
    } finally {
      await rm(journalDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'source team',
      destination: {
        kind: 'cross_team_outbox' as const,
        fromTeamName: 'other-team-a',
        toTeamName: 'team-b',
        toMemberName: 'Reviewer',
      },
      destinationMessageId: 'runtime-delivery-message',
    },
    {
      name: 'target team',
      destination: {
        kind: 'cross_team_outbox' as const,
        fromTeamName: 'team-a',
        toTeamName: 'other-team-b',
        toMemberName: 'Reviewer',
      },
      destinationMessageId: 'runtime-delivery-message',
    },
    {
      name: 'target member',
      destination: {
        kind: 'cross_team_outbox' as const,
        fromTeamName: 'team-a',
        toTeamName: 'team-b',
        toMemberName: 'OtherReviewer',
      },
      destinationMessageId: 'runtime-delivery-message',
    },
  ])(
    'rejects target-runtime proof with mismatched $name identity',
    async ({ destination, destinationMessageId }) => {
      const sentMessagesByTeam = new Map<string, InboxMessage[]>([
        [
          'team-a',
          [
            {
              from: 'Builder',
              to: 'team-b.Reviewer',
              text: 'Please review this',
              timestamp: '2026-04-21T12:00:00.000Z',
              read: true,
              messageId: 'runtime-delivery-message',
              source: CROSS_TEAM_SENT_SOURCE,
            },
          ],
        ],
      ]);
      const port = getCrossTeamPort(
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(() => Promise.resolve()),
            readMessages: vi.fn((teamName: string) =>
              Promise.resolve(sentMessagesByTeam.get(teamName) ?? [])
            ),
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
          destination,
          destinationMessageId,
          location: {
            kind: 'cross_team_outbox',
            fromTeamName: 'team-a',
            toTeamName: 'team-b',
            toMemberName: 'Reviewer',
            messageId: 'runtime-delivery-message',
          },
        })
      ).resolves.toMatchObject({
        found: false,
        location: null,
        diagnostics: ['cross-team target runtime proof mismatch'],
      });
    }
  );

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
  return getRuntimePort(ports, 'cross_team_outbox');
}

function getRuntimePort(
  ports: RuntimeDeliveryDestinationPort[],
  kind: RuntimeDeliveryDestinationPort['kind']
): RuntimeDeliveryDestinationPort {
  const port = ports.find((candidate) => candidate.kind === kind);
  if (!port) {
    throw new Error(`${kind} runtime delivery port not registered`);
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
