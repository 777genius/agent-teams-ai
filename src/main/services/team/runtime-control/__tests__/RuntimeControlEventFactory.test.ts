import { describe, expect, it } from 'vitest';

import {
  buildRuntimeControlCommandEventId,
  buildRuntimeDeliverMessageCommandId,
  createRuntimeControlEventFromAck,
} from '../index';

import type { RuntimeControlAck, RuntimeDeliverMessageCommand } from '../index';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('RuntimeControlEventFactory', () => {
  it('creates stable delivered and duplicate events from the same command contract', () => {
    const command = createDeliveryCommand();
    const delivered = createRuntimeControlEventFromAck(command, createAck('delivered'));
    const duplicate = createRuntimeControlEventFromAck(command, createAck('duplicate'));

    expect(delivered).toMatchObject({
      eventId: buildRuntimeControlCommandEventId({
        providerId: 'opencode',
        eventType: 'RuntimeMessageDelivered',
        commandId: command.commandId,
      }),
      type: 'RuntimeMessageDelivered',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      commandId: command.commandId,
      idempotencyKey: 'message-key-1',
      fromMemberName: 'Builder',
      location: { inbox: 'user.json' },
    });
    expect(duplicate).toMatchObject({
      eventId: buildRuntimeControlCommandEventId({
        providerId: 'opencode',
        eventType: 'RuntimeMessageDuplicate',
        commandId: command.commandId,
      }),
      type: 'RuntimeMessageDuplicate',
      idempotencyKey: 'message-key-1',
    });
  });

  it('rejects mismatched provider acknowledgements before emitting events', () => {
    expect(() =>
      createRuntimeControlEventFromAck(createDeliveryCommand(), {
        ...createAck('delivered'),
        providerId: 'subscription',
      })
    ).toThrow('Runtime control ack provider mismatch: expected opencode, received subscription');
  });
});

function createDeliveryCommand(): RuntimeDeliverMessageCommand {
  return {
    commandId: buildRuntimeDeliverMessageCommandId({
      providerId: 'opencode',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      idempotencyKey: 'message-key-1',
    }),
    kind: 'runtime.deliver-message',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    idempotencyKey: 'message-key-1',
    fromMemberName: 'Builder',
    runtimeSessionId: 'session-1',
    target: 'user',
    text: 'Delivered text',
    createdAt: OBSERVED_AT,
  };
}

function createAck(state: RuntimeControlAck['state']): RuntimeControlAck {
  return {
    ok: true,
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    state,
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    idempotencyKey: 'message-key-1',
    location: { inbox: 'user.json' },
    diagnostics: [],
    observedAt: OBSERVED_AT,
  };
}
