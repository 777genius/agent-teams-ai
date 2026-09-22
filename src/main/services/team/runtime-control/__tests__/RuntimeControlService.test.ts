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
import { KeyedRuntimeDeliveryWriteFence } from '../RuntimeControlService';

import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeControlAck,
  RuntimeDeliverMessageCommand,
  RuntimePermissionAnswerCommand,
} from '../index';
import type { RuntimeDeliveryWriteFence } from '../RuntimeControlService';

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
      let result!: Promise<RuntimeControlAck>;
      expect(() => {
        result = service.recordBootstrapCheckin(command);
      }).not.toThrow();
      try {
        await result;
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
      let result!: Promise<RuntimeControlAck>;
      expect(() => {
        result = service.deliverMessage(command);
      }).not.toThrow();
      try {
        await result;
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

  it('rejects a provider delivery status that does not match the routed operation without an event sink', async () => {
    const deliverMessage = vi.fn(async () => createAck({ state: 'accepted' }));
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);

    await expect(service.deliverMessage(createDeliverCommand())).rejects.toThrow(
      'Runtime control ack state mismatch for runtime.deliver-message: expected delivered or duplicate, received accepted'
    );

    expect(deliverMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects stale provider acknowledgement identity without depending on event recording', async () => {
    const deliverMessage = vi.fn(async () =>
      createAck({
        runId: 'stale-run',
        state: 'delivered',
        idempotencyKey: 'message-key-1',
      })
    );
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);

    await expect(service.deliverMessage(createDeliverCommand())).rejects.toThrow(
      'Runtime control ack run mismatch: expected run-1, received stale-run'
    );
  });

  it.each(['delivered', 'duplicate'] as const)(
    'rejects a %s acknowledgement for a different idempotency key before recording an event',
    async (state) => {
      const deliverMessage = vi.fn(async () =>
        createAck({ state, idempotencyKey: 'stale-message-key' })
      );
      const record = vi.fn();
      const service = new RuntimeControlService({
        providers: [{ providerId: 'opencode', deliverMessage }],
        eventSink: { record },
      });

      await expect(service.deliverMessage(createDeliverCommand())).rejects.toThrow(
        'Runtime control ack idempotency mismatch: expected message-key-1, received stale-message-key'
      );
      expect(record).not.toHaveBeenCalled();
    }
  );

  it('holds exactly one fence only around the provider delivery commit', async () => {
    const command = createDeliverCommand();
    const ack = createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    let acquisitions = 0;
    let insideFence = false;
    const deliveryWriteFence: RuntimeDeliveryWriteFence = {
      async runExclusive<T>(_key: string, action: () => Promise<T>): Promise<T> {
        acquisitions += 1;
        insideFence = true;
        try {
          return await action();
        } finally {
          insideFence = false;
        }
      },
    };
    const deliverMessage = vi.fn(async () => {
      expect(insideFence).toBe(true);
      return ack;
    });
    const record = vi.fn(async () => {
      expect(insideFence).toBe(false);
    });
    const service = new RuntimeControlService({
      providers: [{ providerId: 'opencode', deliverMessage }],
      eventSink: { record },
      deliveryWriteFence,
    });

    await expect(service.deliverMessage(command)).resolves.toBe(ack);

    expect(acquisitions).toBe(1);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('serializes conflicting payloads that share the same canonical delivery key', async () => {
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const seenTexts: string[] = [];
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      seenTexts.push(command.text);
      if (seenTexts.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey.trim() });
    });
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);
    const firstCommand = createDeliverCommand({ text: 'original payload' });
    const conflictingCommand = createDeliverCommand({ text: 'conflicting payload' });

    const first = service.deliverMessage(firstCommand);
    await firstEntered.promise;
    const conflicting = service.deliverMessage(conflictingCommand);

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, conflicting])).resolves.toHaveLength(2);
    expect(seenTexts).toEqual(['original payload', 'conflicting payload']);
  });

  it('preserves command idempotency keys while serializing their shared runtime lane', async () => {
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const enteredKeys: string[] = [];
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      enteredKeys.push(command.idempotencyKey);
      if (enteredKeys.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey.trim() });
    });
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);

    const padded = service.deliverMessage(
      createDeliverCommand({ idempotencyKey: '  message-key-1  ' })
    );
    await firstEntered.promise;
    const canonical = service.deliverMessage(createDeliverCommand());

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([padded, canonical])).resolves.toHaveLength(2);
    expect(enteredKeys).toEqual(['  message-key-1  ', 'message-key-1']);
  });

  it('serializes different messages that target the same runtime lane', async () => {
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const enteredKeys: string[] = [];
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      enteredKeys.push(command.idempotencyKey);
      if (enteredKeys.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    });
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);

    const first = service.deliverMessage(createDeliverCommand());
    await firstEntered.promise;
    const second = service.deliverMessage(
      createDeliverCommand({ idempotencyKey: 'message-key-2' })
    );

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(enteredKeys).toEqual(['message-key-1', 'message-key-2']);
  });

  it('keeps unrelated runtime lanes concurrent', async () => {
    const release = createDeferred();
    const enteredLanes = new Set<string>();
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      if (command.laneId === undefined) {
        throw new Error('Expected delivery command to include a runtime lane ID.');
      }
      enteredLanes.add(command.laneId);
      await release.promise;
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    });
    const service = new RuntimeControlService([{ providerId: 'opencode', deliverMessage }]);
    const deliveries = [
      service.deliverMessage(createDeliverCommand()),
      service.deliverMessage(
        createDeliverCommand({ laneId: 'lane-2', idempotencyKey: 'message-key-2' })
      ),
    ];

    try {
      await vi.waitFor(() => expect(enteredLanes).toEqual(new Set(['lane-1', 'lane-2'])));
    } finally {
      release.resolve();
    }

    await expect(Promise.all(deliveries)).resolves.toHaveLength(2);
  });

  it('releases a failed delivery to its waiter and removes the final queue tail', async () => {
    const deliveryWriteFence = new KeyedRuntimeDeliveryWriteFence();
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    let calls = 0;
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw new Error('provider commit failed');
      }
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    });
    const service = new RuntimeControlService({
      providers: [{ providerId: 'opencode', deliverMessage }],
      deliveryWriteFence,
    });

    const first = service.deliverMessage(createDeliverCommand());
    await firstEntered.promise;
    const second = service.deliverMessage(createDeliverCommand());
    const settled = Promise.allSettled([first, second]);

    expect(getFenceTailCount(deliveryWriteFence)).toBe(1);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(settled).resolves.toMatchObject([
      { status: 'rejected', reason: new Error('provider commit failed') },
      { status: 'fulfilled', value: { state: 'delivered' } },
    ]);
    expect(deliverMessage).toHaveBeenCalledTimes(2);
    expect(getFenceTailCount(deliveryWriteFence)).toBe(0);
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

  it('serializes permission answers that mutate the same runtime lane', async () => {
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const enteredRequests: string[] = [];
    const answerPermission = vi.fn(async (command: RuntimePermissionAnswerCommand) => {
      enteredRequests.push(command.requestId);
      if (enteredRequests.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return createAck({ state: 'accepted' });
    });
    const service = new RuntimeControlService([{ providerId: 'opencode', answerPermission }]);

    const first = service.answerPermission(createPermissionAnswerCommand());
    await firstEntered.promise;
    const second = service.answerPermission(
      createPermissionAnswerCommand({ requestId: 'provider-request-2' })
    );

    expect(answerPermission).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(enteredRequests).toEqual(['provider-request-1', 'provider-request-2']);
  });

  it('blocks a permission answer behind an in-flight delivery on the same runtime lane', async () => {
    const deliveryEntered = createDeferred();
    const releaseDelivery = createDeferred();
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      deliveryEntered.resolve();
      await releaseDelivery.promise;
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    });
    const answerPermission = vi.fn(async () => createAck({ state: 'accepted' }));
    const service = new RuntimeControlService([
      { providerId: 'opencode', deliverMessage, answerPermission },
    ]);

    const delivery = service.deliverMessage(createDeliverCommand());
    await deliveryEntered.promise;
    const answer = service.answerPermission(createPermissionAnswerCommand());

    expect(answerPermission).not.toHaveBeenCalled();
    releaseDelivery.resolve();

    await expect(Promise.all([delivery, answer])).resolves.toHaveLength(2);
    expect(answerPermission).toHaveBeenCalledTimes(1);
  });

  it('blocks a delivery behind an in-flight permission answer on the same runtime lane', async () => {
    const answerEntered = createDeferred();
    const releaseAnswer = createDeferred();
    const answerPermission = vi.fn(async () => {
      answerEntered.resolve();
      await releaseAnswer.promise;
      return createAck({ state: 'accepted' });
    });
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) =>
      createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey })
    );
    const service = new RuntimeControlService([
      { providerId: 'opencode', deliverMessage, answerPermission },
    ]);

    const answer = service.answerPermission(createPermissionAnswerCommand());
    await answerEntered.promise;
    const delivery = service.deliverMessage(createDeliverCommand());

    expect(deliverMessage).not.toHaveBeenCalled();
    releaseAnswer.resolve();

    await expect(Promise.all([answer, delivery])).resolves.toHaveLength(2);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps delivery and permission-answer commits on unrelated runtime lanes concurrent', async () => {
    const release = createDeferred();
    const enteredLanes = new Set<string>();
    const deliverMessage = vi.fn(async (command: RuntimeDeliverMessageCommand) => {
      enteredLanes.add(`delivery:${command.laneId}`);
      await release.promise;
      return createAck({ state: 'delivered', idempotencyKey: command.idempotencyKey });
    });
    const answerPermission = vi.fn(async (command: RuntimePermissionAnswerCommand) => {
      enteredLanes.add(`permission:${command.laneId}`);
      await release.promise;
      return createAck({ state: 'accepted' });
    });
    const service = new RuntimeControlService([
      { providerId: 'opencode', deliverMessage, answerPermission },
    ]);
    const commands = [
      service.deliverMessage(createDeliverCommand()),
      service.answerPermission(createPermissionAnswerCommand({ laneId: 'lane-2' })),
    ];

    try {
      await vi.waitFor(() =>
        expect(enteredLanes).toEqual(new Set(['delivery:lane-1', 'permission:lane-2']))
      );
    } finally {
      release.resolve();
    }

    await expect(Promise.all(commands)).resolves.toHaveLength(2);
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

function createDeliverCommand(
  overrides: Partial<RuntimeDeliverMessageCommand> = {}
): RuntimeDeliverMessageCommand {
  const providerId = overrides.providerId ?? 'opencode';
  const teamName = overrides.teamName ?? 'Team';
  const laneId = overrides.laneId ?? 'lane-1';
  const runId = overrides.runId ?? 'run-1';
  const idempotencyKey = overrides.idempotencyKey ?? 'message-key-1';
  return {
    commandId:
      overrides.commandId ??
      buildRuntimeControlCommandId({
        providerId,
        verb: 'deliver-message',
        teamName,
        laneId,
        runId,
        parts: [idempotencyKey],
      }),
    kind: 'runtime.deliver-message',
    providerId,
    teamName,
    runId,
    laneId,
    idempotencyKey,
    fromMemberName: 'Builder',
    runtimeSessionId: 'session-1',
    target: 'user',
    text: 'Delivered text',
    createdAt: OBSERVED_AT,
    ...overrides,
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

function createPermissionAnswerCommand(
  overrides: Partial<RuntimePermissionAnswerCommand> = {}
): RuntimePermissionAnswerCommand {
  const providerId = overrides.providerId ?? 'opencode';
  const teamName = overrides.teamName ?? 'Team';
  const laneId = overrides.laneId ?? 'lane-1';
  const runId = overrides.runId ?? 'run-1';
  const requestId = overrides.requestId ?? 'provider-request-1';
  const decision = overrides.decision ?? 'allow';
  return {
    commandId:
      overrides.commandId ??
      buildRuntimePermissionAnswerCommandId({
        providerId,
        teamName,
        laneId,
        runId,
        requestId,
        decision,
      }),
    kind: 'runtime.permission-answer',
    providerId,
    teamName,
    runId,
    laneId,
    cwd: '/repo',
    memberName: 'Builder',
    requestId,
    decision,
    expectedMembers: [{ name: 'Builder', providerId: 'opencode', cwd: '/repo' }],
    previousLaunchState: null,
    ...overrides,
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function getFenceTailCount(fence: KeyedRuntimeDeliveryWriteFence): number {
  return (fence as unknown as { tails: Map<string, Promise<void>> }).tails.size;
}
