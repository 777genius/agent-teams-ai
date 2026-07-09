import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeBootstrapCheckinCommandId,
  buildRuntimeControlCommandEventId,
  buildRuntimeControlCommandId,
  buildRuntimePermissionAnswerCommandId,
  RuntimeControlProviderRegistry,
  RuntimeControlProviderRoutingError,
  RuntimeControlService,
} from '../index';

import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeControlAck,
  RuntimeDeliverMessageCommand,
  RuntimePermissionAnswerCommand,
} from '../index';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('RuntimeControlService', () => {
  it('routes commands to the registered provider handler', async () => {
    const command = createBootstrapCommand();
    const ack = createAck();
    const recordBootstrapCheckin = vi.fn(async () => ack);
    const service = new RuntimeControlService([
      {
        providerId: 'opencode',
        recordBootstrapCheckin,
      },
    ]);

    await expect(service.recordBootstrapCheckin(command)).resolves.toBe(ack);

    expect(recordBootstrapCheckin).toHaveBeenCalledTimes(1);
    expect(recordBootstrapCheckin).toHaveBeenCalledWith(command);
  });

  it('keeps provider registration duplicate-safe', () => {
    expect(
      () =>
        new RuntimeControlProviderRegistry([{ providerId: 'opencode' }, { providerId: 'opencode' }])
    ).toThrow('Runtime control provider already registered: opencode');
  });

  it('returns provider ids as a copy of registry state', () => {
    const service = new RuntimeControlService([{ providerId: 'opencode' }]);
    const providerIds = service.providerIds();

    providerIds.push('subscription');

    expect(service.providerIds()).toEqual(['opencode']);
    expect(service.hasProvider('opencode')).toBe(true);
    expect(service.hasProvider('subscription')).toBe(false);
  });

  it('throws stable routing errors when the provider is not registered', async () => {
    const recordBootstrapCheckin = vi.fn(async () => createAck());
    const service = new RuntimeControlService([
      {
        providerId: 'opencode',
        recordBootstrapCheckin,
      },
    ]);
    const command = createBootstrapCommand({ providerId: 'subscription' });

    const messages: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await service.recordBootstrapCheckin(command);
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeControlProviderRoutingError);
        expect(error).toMatchObject({
          providerId: 'subscription',
          operation: 'recordBootstrapCheckin',
          reason: 'provider_not_registered',
        });
        messages.push((error as Error).message);
      }
    }

    expect(messages).toEqual([
      'Runtime control provider is not registered: subscription',
      'Runtime control provider is not registered: subscription',
    ]);
    expect(recordBootstrapCheckin).not.toHaveBeenCalled();
  });

  it('throws stable routing errors when a provider does not support the operation', async () => {
    const service = new RuntimeControlService([{ providerId: 'opencode' }]);
    const command = createDeliverCommand();

    const messages: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await service.deliverMessage(command);
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeControlProviderRoutingError);
        expect(error).toMatchObject({
          providerId: 'opencode',
          operation: 'deliverMessage',
          reason: 'operation_not_supported',
        });
        messages.push((error as Error).message);
      }
    }

    expect(messages).toEqual([
      'Runtime control provider opencode does not support deliverMessage',
      'Runtime control provider opencode does not support deliverMessage',
    ]);
  });

  it('emits idempotent command-result events through the optional event sink', async () => {
    const command = createDeliverCommand();
    const ack = createAck({
      state: 'delivered',
      idempotencyKey: command.idempotencyKey,
      location: { inbox: 'user.json' },
    });
    const deliverMessage = vi.fn(async () => ack);
    const record = vi.fn();
    const service = new RuntimeControlService({
      providers: [
        {
          providerId: 'opencode',
          deliverMessage,
        },
      ],
      eventSink: { record },
    });

    await expect(service.deliverMessage(command)).resolves.toBe(ack);
    await expect(service.deliverMessage(command)).resolves.toBe(ack);

    const expectedEventId = buildRuntimeControlCommandEventId({
      providerId: 'opencode',
      eventType: 'RuntimeMessageDelivered',
      commandId: command.commandId,
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventId: expectedEventId,
        type: 'RuntimeMessageDelivered',
        providerId: 'opencode',
        teamName: 'Team',
        runId: 'run-1',
        laneId: 'lane-1',
        commandId: command.commandId,
        idempotencyKey: 'message-key-1',
        fromMemberName: 'Builder',
        location: { inbox: 'user.json' },
      })
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventId: expectedEventId,
      })
    );
  });

  it('routes permission answers and records the answer event', async () => {
    const command = createPermissionAnswerCommand();
    const ack = createAck({ state: 'accepted' });
    const answerPermission = vi.fn(async () => ack);
    const record = vi.fn();
    const service = new RuntimeControlService({
      providers: [{ providerId: 'opencode', answerPermission }],
      eventSink: { record },
    });

    await expect(service.answerPermission(command)).resolves.toBe(ack);

    expect(answerPermission).toHaveBeenCalledWith(command);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RuntimePermissionAnswered',
        providerId: 'opencode',
        teamName: 'Team',
        runId: 'run-1',
        laneId: 'lane-1',
        requestId: 'provider-request-1',
        decision: 'allow',
      })
    );
  });
});

function createBootstrapCommand(
  overrides: Partial<RuntimeBootstrapCheckinCommand> = {}
): RuntimeBootstrapCheckinCommand {
  const providerId = overrides.providerId ?? 'opencode';
  return {
    commandId: buildRuntimeBootstrapCheckinCommandId({
      providerId,
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
    }),
    kind: 'runtime.bootstrap-checkin',
    providerId,
    teamName: 'Team',
    runId: 'run-1',
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function createDeliverCommand(): RuntimeDeliverMessageCommand {
  return {
    commandId: buildRuntimeControlCommandId({
      providerId: 'opencode',
      verb: 'deliver-message',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      parts: ['message-key-1'],
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

function createAck(overrides: Partial<RuntimeControlAck> = {}): RuntimeControlAck {
  return {
    ok: true,
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    state: 'accepted',
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    diagnostics: [],
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function createPermissionAnswerCommand(): RuntimePermissionAnswerCommand {
  return {
    commandId: buildRuntimePermissionAnswerCommandId({
      providerId: 'opencode',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      requestId: 'provider-request-1',
      decision: 'allow',
    }),
    kind: 'runtime.permission-answer',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    cwd: '/repo',
    memberName: 'Builder',
    requestId: 'provider-request-1',
    decision: 'allow',
    expectedMembers: [{ name: 'Builder', providerId: 'opencode', cwd: '/repo' }],
    previousLaunchState: null,
  };
}
