import { describe, expect, it, vi } from 'vitest';

import { createTeamRuntimeControlCompatibilityApi } from '../index';

import type {
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeControlPort,
  RuntimeControlEvent,
} from '../index';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('TeamRuntimeControlCompatibility', () => {
  it('keeps the TeamProvisioningService compatibility surface as a thin OpenCode delegate', async () => {
    const ack: OpenCodeRuntimeControlAck = {
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      diagnostics: [],
      observedAt: OBSERVED_AT,
    };
    const openCode = createOpenCodePort(ack);
    const api = createTeamRuntimeControlCompatibilityApi({
      openCode,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    });

    await expect(
      api.recordOpenCodeRuntimeBootstrapCheckin({
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Builder',
        runtimeSessionId: 'session-1',
        observedAt: OBSERVED_AT,
      })
    ).resolves.toBe(ack);

    expect(openCode.recordOpenCodeRuntimeBootstrapCheckin).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
      diagnostics: [],
    });
  });

  it('delegates every runtime control compatibility operation through OpenCode ports', async () => {
    const ack: OpenCodeRuntimeControlAck = {
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'recorded',
      diagnostics: [],
      observedAt: OBSERVED_AT,
    };
    const openCode = createOpenCodePort(ack);
    const resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'lane-1');
    const api = createTeamRuntimeControlCompatibilityApi({
      openCode,
      resolveOpenCodeRuntimeLaneId,
    });

    await api.recordOpenCodeRuntimeBootstrapCheckin({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
    await api.deliverOpenCodeRuntimeMessage({
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: { memberName: 'Reviewer' },
      text: 'Delivered text',
      createdAt: OBSERVED_AT,
      summary: null,
    });
    await api.recordOpenCodeRuntimeTaskEvent({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: 'task-key-1',
      runtimeSessionId: 'session-1',
      createdAt: OBSERVED_AT,
    });
    await api.recordOpenCodeRuntimeHeartbeat({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });

    expect(resolveOpenCodeRuntimeLaneId).toHaveBeenCalledTimes(4);
    expect(openCode.recordOpenCodeRuntimeBootstrapCheckin).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
      diagnostics: [],
    });
    expect(openCode.deliverOpenCodeRuntimeMessage).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: { memberName: 'Reviewer' },
      text: 'Delivered text',
      createdAt: OBSERVED_AT,
      summary: null,
    });
    expect(openCode.recordOpenCodeRuntimeTaskEvent).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: 'task-key-1',
      runtimeSessionId: 'session-1',
      createdAt: OBSERVED_AT,
    });
    expect(openCode.recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
  });

  it('wires the event sink through compatibility API composition for every OpenCode operation', async () => {
    const events: RuntimeControlEvent[] = [];
    const record = vi.fn((event: RuntimeControlEvent) => {
      events.push(event);
    });
    const openCode: OpenCodeRuntimeControlPort = {
      recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => createOpenCodeAck('accepted')),
      deliverOpenCodeRuntimeMessage: vi.fn(async () => createOpenCodeAck('delivered')),
      recordOpenCodeRuntimeTaskEvent: vi.fn(async () => createOpenCodeAck('recorded')),
      recordOpenCodeRuntimeHeartbeat: vi.fn(async () => createOpenCodeAck('accepted')),
    };
    const api = createTeamRuntimeControlCompatibilityApi({
      openCode,
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
      eventSink: { record },
    });

    await api.recordOpenCodeRuntimeBootstrapCheckin({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
    await api.deliverOpenCodeRuntimeMessage({
      teamName: 'Team',
      runId: 'run-1',
      fromMemberName: 'Builder',
      idempotencyKey: 'message-key-1',
      runtimeSessionId: 'session-1',
      to: { memberName: 'Reviewer' },
      text: 'Delivered text',
      createdAt: OBSERVED_AT,
    });
    await api.recordOpenCodeRuntimeTaskEvent({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      taskId: 'task-1',
      event: 'started',
      idempotencyKey: 'task-key-1',
      runtimeSessionId: 'session-1',
      createdAt: OBSERVED_AT,
    });
    await api.recordOpenCodeRuntimeHeartbeat({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });

    expect(record).toHaveBeenCalledTimes(4);
    expect(events.map((event) => event.type)).toEqual([
      'RuntimeBootstrapAccepted',
      'RuntimeMessageDelivered',
      'RuntimeTaskEventRecorded',
      'RuntimeHeartbeatAccepted',
    ]);
    expect(events[0]).toMatchObject({
      type: 'RuntimeBootstrapAccepted',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
    });
    expect(events[1]).toMatchObject({
      type: 'RuntimeMessageDelivered',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      idempotencyKey: 'message-key-1',
      fromMemberName: 'Builder',
    });
    expect(events[2]).toMatchObject({
      type: 'RuntimeTaskEventRecorded',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      memberName: 'Builder',
      taskId: 'task-1',
      taskEvent: 'started',
      idempotencyKey: 'task-key-1',
    });
    expect(events[3]).toMatchObject({
      type: 'RuntimeHeartbeatAccepted',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
    });
  });
});

function createOpenCodePort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
  };
}

function createOpenCodeAck(
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
