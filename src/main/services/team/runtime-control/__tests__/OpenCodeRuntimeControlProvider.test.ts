import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeBootstrapCheckinCommandId,
  buildRuntimeDeliverMessageCommandId,
  buildRuntimeHeartbeatCommandId,
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

    await expect(provider.recordBootstrapCheckin?.(bootstrapCommand)).resolves.toBe(ack);
    await expect(provider.deliverMessage?.(deliveryCommand)).resolves.toBe(ack);
    await expect(provider.recordTaskEvent?.(taskEventCommand)).resolves.toBe(ack);
    await expect(provider.recordHeartbeat?.(heartbeatCommand)).resolves.toBe(ack);

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
  });

  it('returns the canonical runtime-control OpenCode ack through the router', async () => {
    const ack = createAck('delivered');
    const router = createOpenCodeRuntimeControlRouter(createPort(ack));

    await expect(router.deliverMessage(createDeliveryCommand())).resolves.toBe(ack);
  });
});

function createPort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
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
    target: { memberName: 'Reviewer' },
    text: 'Delivered text',
    createdAt: OBSERVED_AT,
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }],
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

function createAck(state: OpenCodeRuntimeControlAck['state']): OpenCodeRuntimeControlAck {
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
  };
}
