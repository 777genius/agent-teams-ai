import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeControlCommandEventId,
  createOpenCodeRuntimeControlApi,
  createRuntimeControlEventFromAck,
} from '../index';

import type {
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeControlApiPorts,
  OpenCodeRuntimeControlRouter,
} from '../index';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('OpenCodeRuntimeControlApi', () => {
  it('builds stable bootstrap commands and routes them through runtime control', async () => {
    const ack = createAck('accepted');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);

    await expect(
      api.recordOpenCodeRuntimeBootstrapCheckin({
        teamName: ' Team ',
        runId: ' run-1 ',
        memberName: ' Builder ',
        runtimeSessionId: ' session-1 ',
        observedAt: '2026-01-01T00:00:00Z',
        diagnostics: ['ready', 1],
        metadata: { runtimePid: 1234, nested: { ignored: true } },
      })
    ).resolves.toBe(ack);

    expect(ports.resolveOpenCodeRuntimeLaneId).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
    });
    expect(ports.runtimeControl.recordBootstrapCheckin).toHaveBeenCalledWith({
      commandId: 'opencode:bootstrap-checkin:Team:lane-1:run-1:Builder:session-1',
      kind: 'runtime.bootstrap-checkin',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
      diagnostics: ['ready'],
      metadata: { runtimePid: 1234 },
    });
  });

  it('maps OpenCode delivery fields onto provider-neutral commands', async () => {
    const ack = createAck('delivered');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);
    const raw = {
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: { teamName: ' Other Team ', memberName: ' Reviewer ' },
      text: 'Delivered text',
      createdAt: '2026-01-01T00:00:00Z',
      summary: 42,
      taskRefs: [{ taskId: ' task-1 ', displayId: ' #1 ', teamName: ' Team ' }, ' TASK-2 '],
    };

    await expect(api.deliverOpenCodeRuntimeMessage(raw)).resolves.toBe(ack);
    await expect(api.deliverOpenCodeRuntimeMessage(raw)).resolves.toBe(ack);

    const firstCommand = vi.mocked(ports.runtimeControl.deliverMessage).mock.calls[0]?.[0];
    expect(firstCommand).toEqual({
      commandId: 'opencode:deliver-message:Team:lane-1:run-1:message-key-1',
      kind: 'runtime.deliver-message',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      idempotencyKey: 'message-key-1',
      fromMemberName: 'Builder',
      runtimeSessionId: 'session-1',
      target: { teamName: 'Other Team', memberName: 'Reviewer' },
      text: 'Delivered text',
      createdAt: OBSERVED_AT,
      summary: '42',
      taskRefs: [
        { taskId: 'task-1', displayId: '#1', teamName: 'Team' },
        { taskId: 'TASK-2', displayId: 'TASK-2', teamName: 'Team' },
      ],
    });
    expect(firstCommand).not.toHaveProperty('to');
    expect(ports.runtimeControl.deliverMessage).toHaveBeenNthCalledWith(2, firstCommand);
  });

  it('canonicalizes delivery idempotency keys before command and event identity', async () => {
    const ack = createAck('delivered');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);

    await expect(
      api.deliverOpenCodeRuntimeMessage({
        teamName: 'Team',
        runId: 'run-1',
        fromMemberName: 'Builder',
        idempotencyKey: ' message-key-1 ',
        runtimeSessionId: 'session-1',
        to: 'user',
        text: 'Delivered text',
        createdAt: '2026-01-01T00:00:00Z',
      })
    ).resolves.toBe(ack);

    const command = vi.mocked(ports.runtimeControl.deliverMessage).mock.calls[0]?.[0];
    expect(command).toBeDefined();
    if (!command) {
      throw new Error('Expected delivery command');
    }
    expect(command).toEqual(
      expect.objectContaining({
        commandId: 'opencode:deliver-message:Team:lane-1:run-1:message-key-1',
        idempotencyKey: 'message-key-1',
      })
    );
    expect(
      createRuntimeControlEventFromAck(command, {
        ...ack,
        idempotencyKey: command.idempotencyKey,
      })
    ).toEqual(
      expect.objectContaining({
        eventId: buildRuntimeControlCommandEventId({
          providerId: 'opencode',
          eventType: 'RuntimeMessageDelivered',
          commandId: command.commandId,
        }),
        commandId: command.commandId,
        idempotencyKey: 'message-key-1',
      })
    );
  });

  it('keeps blank delivery idempotency keys invalid after canonicalization', async () => {
    const ack = createAck('delivered');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);

    await expect(
      api.deliverOpenCodeRuntimeMessage({
        teamName: 'Team',
        runId: 'run-1',
        fromMemberName: 'Builder',
        idempotencyKey: '   ',
        runtimeSessionId: 'session-1',
        to: 'user',
        text: 'Delivered text',
        createdAt: '2026-01-01T00:00:00Z',
      })
    ).rejects.toThrow('Runtime delivery envelope missing idempotencyKey');
    expect(ports.runtimeControl.deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects malformed task refs before they enter runtime control', async () => {
    const ack = createAck('delivered');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);

    await expect(
      api.deliverOpenCodeRuntimeMessage({
        teamName: 'Team',
        runId: 'run-1',
        fromMemberName: 'Builder',
        idempotencyKey: 'message-key-1',
        runtimeSessionId: 'session-1',
        to: 'user',
        text: 'Delivered text',
        createdAt: '2026-01-01T00:00:00Z',
        taskRefs: [{ taskId: 'task-1', displayId: ' ', teamName: 'Team' }],
      })
    ).rejects.toThrow('Runtime delivery envelope missing taskRefs[0].displayId');

    expect(ports.runtimeControl.deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid delivery createdAt before runtime control', async () => {
    const ack = createAck('delivered');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);
    const raw = {
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: 'user',
      text: 'Delivered text',
    };

    await expect(api.deliverOpenCodeRuntimeMessage(raw)).rejects.toThrow(
      'Runtime delivery envelope missing createdAt'
    );
    await expect(
      api.deliverOpenCodeRuntimeMessage({ ...raw, createdAt: 'not-a-date' })
    ).rejects.toThrow('Runtime delivery envelope invalid createdAt');

    expect(ports.runtimeControl.deliverMessage).not.toHaveBeenCalled();
  });

  it('builds stable task-event and heartbeat command ids', async () => {
    const ack = createAck('recorded');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);

    await api.recordOpenCodeRuntimeTaskEvent({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: ' task-key-1 ',
      runtimeSessionId: 'session-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await api.recordOpenCodeRuntimeHeartbeat({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: '2026-01-01T00:00:00Z',
      status: 'alive',
      metadata: { runtimeVersion: '1.0.0' },
    });

    expect(ports.runtimeControl.recordTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'opencode:task-event:Team:lane-1:run-1:task-key-1',
        kind: 'runtime.task-event',
        providerId: 'opencode',
        teamName: 'Team',
        runId: 'run-1',
        laneId: 'lane-1',
        memberName: 'Builder',
        taskId: 'task-1',
        event: 'started',
        idempotencyKey: 'task-key-1',
        runtimeSessionId: 'session-1',
        createdAt: OBSERVED_AT,
      })
    );
    expect(ports.runtimeControl.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId:
          'opencode:heartbeat:Team:lane-1:run-1:Builder:session-1:2026-01-01T00%3A00%3A00.000Z',
        kind: 'runtime.heartbeat',
        providerId: 'opencode',
        teamName: 'Team',
        runId: 'run-1',
        laneId: 'lane-1',
        memberName: 'Builder',
        runtimeSessionId: 'session-1',
        observedAt: OBSERVED_AT,
        status: 'alive',
        metadata: { runtimeVersion: '1.0.0' },
      })
    );
  });

  it('rejects missing or invalid task-event createdAt before runtime control', async () => {
    const ack = createAck('recorded');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);
    const raw = {
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: 'task-key-1',
    };

    await expect(api.recordOpenCodeRuntimeTaskEvent(raw)).rejects.toThrow(
      'OpenCode runtime payload missing createdAt'
    );
    await expect(
      api.recordOpenCodeRuntimeTaskEvent({ ...raw, createdAt: 'not-a-date' })
    ).rejects.toThrow('OpenCode runtime payload invalid createdAt');

    expect(ports.runtimeControl.recordTaskEvent).not.toHaveBeenCalled();
  });

  it('maps OpenCode permission answers onto the runtime-control answer command', async () => {
    const ack = createAck('accepted');
    const ports = createPorts(ack);
    const api = createOpenCodeRuntimeControlApi(ports);
    const previousLaunchState = { teamName: 'Team', runId: 'run-1' };

    await expect(
      api.answerOpenCodeRuntimePermission({
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Builder',
        requestId: 'opencode:run-1:provider-request-1',
        decision: 'allow',
        cwd: '/repo',
        expectedMembers: [
          {
            name: ' Builder ',
            role: ' Build ',
            providerId: 'opencode',
            cwd: ' /repo ',
          },
        ],
        previousLaunchState,
      })
    ).resolves.toBe(ack);

    expect(ports.resolveOpenCodeRuntimeLaneId).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
    });
    expect(ports.runtimeControl.answerPermission).toHaveBeenCalledWith({
      commandId: 'opencode:permission-answer:Team:lane-1:run-1:provider-request-1:allow',
      kind: 'runtime.permission-answer',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      cwd: '/repo',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'allow',
      expectedMembers: [
        {
          name: 'Builder',
          role: 'Build',
          providerId: 'opencode',
          cwd: '/repo',
        },
      ],
      previousLaunchState,
    });
  });
});

function createPorts(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlApiPorts {
  return {
    runtimeControl: {
      recordBootstrapCheckin: vi.fn(async () => ack),
      deliverMessage: vi.fn(async () => ack),
      recordTaskEvent: vi.fn(async () => ack),
      recordHeartbeat: vi.fn(async () => ack),
      answerPermission: vi.fn(async () => ack),
    } satisfies OpenCodeRuntimeControlRouter,
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
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
