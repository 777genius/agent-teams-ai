import { AsyncResource } from 'node:async_hooks';

import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeBootstrapCheckinCommandId,
  buildRuntimeControlCommandEventId,
  buildRuntimeDeliverMessageCommandId,
  buildRuntimeHeartbeatCommandId,
  buildRuntimePermissionAnswerCommandId,
  buildRuntimeTaskEventCommandId,
  createOpenCodeRuntimeControlProvider,
  createOpenCodeRuntimeControlRouter,
} from '../index';

import type {
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeControlPort,
  RuntimeBootstrapCheckinCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimeTaskEventCommand,
} from '../index';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('OpenCodeRuntimeControlProvider', () => {
  it('adapts runtime-control commands onto the stable OpenCode compatibility methods', async () => {
    const ack = createAck('accepted');
    const port = createPort(ack);
    const provider = createOpenCodeRuntimeControlProvider(port);
    const bootstrapCommand = createBootstrapCommand();
    const deliveryCommand = createDeliveryCommand();
    const taskEventCommand = createTaskEventCommand();
    const heartbeatCommand = createHeartbeatCommand();
    const permissionAnswerCommand = createPermissionAnswerCommand();

    await expect(provider.recordBootstrapCheckin?.(bootstrapCommand)).resolves.toBe(ack);
    await expect(provider.deliverMessage?.(deliveryCommand)).resolves.toBe(ack);
    await expect(provider.recordTaskEvent?.(taskEventCommand)).resolves.toBe(ack);
    await expect(provider.recordHeartbeat?.(heartbeatCommand)).resolves.toBe(ack);
    await expect(provider.answerPermission?.(permissionAnswerCommand)).resolves.toBe(ack);

    expect(port.recordOpenCodeRuntimeBootstrapCheckin).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
    expect(port.deliverOpenCodeRuntimeMessage).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: { memberName: 'Reviewer' },
      text: 'Delivered text',
      createdAt: OBSERVED_AT,
      taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }],
    });
    expect(port.recordOpenCodeRuntimeTaskEvent).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: 'task-key-1',
      runtimeSessionId: 'session-1',
      createdAt: OBSERVED_AT,
    });
    expect(port.recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
    expect(port.answerOpenCodeRuntimePermission).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      cwd: '/repo',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'reject',
      expectedMembers: [{ name: 'Builder', providerId: 'opencode', cwd: '/repo' }],
      previousLaunchState: null,
    });
  });

  it('returns the canonical runtime-control OpenCode ack through the router', async () => {
    const ack = createAck('delivered');
    const router = createOpenCodeRuntimeControlRouter(createPort(ack));

    await expect(router.deliverMessage(createDeliveryCommand())).resolves.toBe(ack);
  });

  it('passes the event sink through the OpenCode router into RuntimeControlService', async () => {
    const ack = createAck('delivered');
    const record = vi.fn();
    const command = createDeliveryCommand();
    const router = createOpenCodeRuntimeControlRouter(createPort(ack), {
      eventSink: { record },
    });

    await expect(router.deliverMessage(command)).resolves.toBe(ack);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
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
      })
    );
  });

  it('keeps one persistent delivery fence for the lifetime of a direct router', async () => {
    const command = createDeliveryCommand();
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    let calls = 0;
    const port = createPort(createAck('accepted'));
    port.deliverOpenCodeRuntimeMessage = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        return createAck('delivered', { idempotencyKey: command.idempotencyKey });
      }
      return createAck('duplicate', { idempotencyKey: command.idempotencyKey });
    });
    const router = createOpenCodeRuntimeControlRouter(port);

    const first = router.deliverMessage(command);
    await firstEntered.promise;
    const second = router.deliverMessage(createDeliveryCommand({ text: 'conflicting payload' }));

    expect(port.deliverOpenCodeRuntimeMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: 'delivered' },
      { state: 'duplicate' },
    ]);
  });

  it('allows direct same-key event-sink recursion after the provider commit unlocks', async () => {
    const command = createDeliveryCommand();
    const port = createPort(createAck('delivered', { idempotencyKey: command.idempotencyKey }));
    let shouldRecurse = true;
    const nestedAcks: OpenCodeRuntimeControlAck[] = [];
    const record = vi.fn(async () => {
      if (!shouldRecurse) return;
      shouldRecurse = false;
      nestedAcks.push(
        await settleWithin(
          router.deliverMessage(createDeliveryCommand({ text: 'recursive payload' }))
        )
      );
    });
    const router = createOpenCodeRuntimeControlRouter(port, { eventSink: { record } });

    await expect(settleWithin(router.deliverMessage(command))).resolves.toMatchObject({
      state: 'delivered',
    });

    expect(port.deliverOpenCodeRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(nestedAcks).toHaveLength(1);
    expect(nestedAcks[0]).toMatchObject({ state: 'delivered' });
  });

  it('allows same-key event-sink recursion from a detached AsyncResource', async () => {
    const command = createDeliveryCommand();
    const port = createPort(createAck('delivered', { idempotencyKey: command.idempotencyKey }));
    const detached = new AsyncResource('runtime-control-detached-recursion', {
      triggerAsyncId: 0,
      requireManualDestroy: true,
    });
    let shouldRecurse = true;
    let nestedAck: OpenCodeRuntimeControlAck | undefined;
    const record = vi.fn(async () => {
      if (!shouldRecurse) return;
      shouldRecurse = false;
      nestedAck = await new Promise<OpenCodeRuntimeControlAck>((resolve, reject) => {
        detached.runInAsyncScope(() => {
          void router
            .deliverMessage(createDeliveryCommand({ text: 'detached recursive payload' }))
            .then(resolve, reject);
        });
      });
    });
    const router = createOpenCodeRuntimeControlRouter(port, { eventSink: { record } });

    try {
      await expect(settleWithin(router.deliverMessage(command))).resolves.toMatchObject({
        state: 'delivered',
      });
    } finally {
      detached.emitDestroy();
    }

    expect(port.deliverOpenCodeRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(nestedAck).toMatchObject({ state: 'delivered' });
  });
});

function createPort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
    answerOpenCodeRuntimePermission: vi.fn(async () => ack),
  };
}

function createBootstrapCommand(): RuntimeBootstrapCheckinCommand {
  return {
    commandId: buildRuntimeBootstrapCheckinCommandId({
      providerId: 'opencode',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
    }),
    kind: 'runtime.bootstrap-checkin',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    observedAt: OBSERVED_AT,
  };
}

function createDeliveryCommand(
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
      buildRuntimeDeliverMessageCommandId({
        providerId,
        teamName,
        laneId,
        runId,
        idempotencyKey,
      }),
    kind: 'runtime.deliver-message',
    providerId,
    teamName,
    runId,
    laneId,
    idempotencyKey,
    fromMemberName: 'Builder',
    runtimeSessionId: 'session-1',
    target: { memberName: 'Reviewer' },
    text: 'Delivered text',
    createdAt: OBSERVED_AT,
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }],
    ...overrides,
  };
}

function createTaskEventCommand(): RuntimeTaskEventCommand {
  return {
    commandId: buildRuntimeTaskEventCommandId({
      providerId: 'opencode',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      idempotencyKey: 'task-key-1',
    }),
    kind: 'runtime.task-event',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    idempotencyKey: 'task-key-1',
    memberName: 'Builder',
    taskId: 'task-1',
    event: 'started',
    runtimeSessionId: 'session-1',
    createdAt: OBSERVED_AT,
  };
}

function createHeartbeatCommand(): RuntimeHeartbeatCommand {
  return {
    commandId: buildRuntimeHeartbeatCommandId({
      providerId: 'opencode',
      teamName: 'Team',
      laneId: 'lane-1',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    }),
    kind: 'runtime.heartbeat',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    observedAt: OBSERVED_AT,
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
      decision: 'reject',
    }),
    kind: 'runtime.permission-answer',
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    cwd: '/repo',
    memberName: 'Builder',
    requestId: 'provider-request-1',
    decision: 'reject',
    expectedMembers: [{ name: 'Builder', providerId: 'opencode', cwd: '/repo' }],
    previousLaunchState: null,
  };
}

function createAck(
  state: OpenCodeRuntimeControlAck['state'],
  overrides: Partial<OpenCodeRuntimeControlAck> = {}
): OpenCodeRuntimeControlAck {
  return {
    ok: true,
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    state,
    memberName: 'Builder',
    runtimeSessionId: 'session-1',
    diagnostics: [],
    observedAt: OBSERVED_AT,
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

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout!: NodeJS.Timeout;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('runtime-control recursion timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}
