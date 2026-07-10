import { describe, expect, it, vi } from 'vitest';

import {
  createTeamRuntimeControlCompatibilityApi,
  createTeamRuntimeControlCompatibilityApiFromService,
} from '../index';

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
    await api.answerOpenCodeRuntimePermission({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'allow',
      cwd: '/repo',
      expectedMembers: [],
    });

    expect(resolveOpenCodeRuntimeLaneId).toHaveBeenCalledTimes(5);
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
    expect(openCode.answerOpenCodeRuntimePermission).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      cwd: '/repo',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'allow',
      expectedMembers: [],
      previousLaunchState: null,
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
      answerOpenCodeRuntimePermission: vi.fn(async () => createOpenCodeAck('accepted')),
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
    await api.answerOpenCodeRuntimePermission({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'reject',
      cwd: '/repo',
      expectedMembers: [],
    });

    expect(record).toHaveBeenCalledTimes(5);
    expect(events.map((event) => event.type)).toEqual([
      'RuntimeBootstrapAccepted',
      'RuntimeMessageDelivered',
      'RuntimeTaskEventRecorded',
      'RuntimeHeartbeatAccepted',
      'RuntimePermissionAnswered',
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
    expect(events[4]).toMatchObject({
      type: 'RuntimePermissionAnswered',
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-1',
      memberName: 'Builder',
      requestId: 'provider-request-1',
      decision: 'reject',
    });
  });

  it('builds the compatibility API from a service-shaped host', async () => {
    const ack = createOpenCodeAck('accepted');
    const openCode = createOpenCodePort(ack);
    const resolveOpenCodeRuntimeLaneId = vi.fn(async () => 'lane-1');
    const service = {
      createOpenCodeRuntimeDeliveryBoundary: vi.fn(() => openCode),
      createOpenCodeRuntimePermissionAnswerBoundary: vi.fn(() => openCode),
      resolveOpenCodeRuntimeLaneId,
    };
    const api = createTeamRuntimeControlCompatibilityApiFromService(service);

    await expect(
      api.recordOpenCodeRuntimeHeartbeat({
        teamName: 'Team',
        runId: 'run-1',
        memberName: 'Builder',
        runtimeSessionId: 'session-1',
        observedAt: OBSERVED_AT,
      })
    ).resolves.toBe(ack);

    expect(service.createOpenCodeRuntimeDeliveryBoundary).toHaveBeenCalledTimes(1);
    expect(openCode.recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
      runtimeSessionId: 'session-1',
      observedAt: OBSERVED_AT,
    });
    expect(resolveOpenCodeRuntimeLaneId).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      memberName: 'Builder',
    });
  });

  it('owns one persistent delivery fence across per-call production boundary creation', async () => {
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    let calls = 0;
    const openCode = createOpenCodePort(createOpenCodeAck('accepted'));
    openCode.deliverOpenCodeRuntimeMessage = vi.fn(async (raw) => {
      calls += 1;
      const idempotencyKey = getPayloadIdempotencyKey(raw);
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        return createOpenCodeAck('delivered', { idempotencyKey });
      }
      return createOpenCodeAck('duplicate', { idempotencyKey });
    });
    const service = {
      createOpenCodeRuntimeDeliveryBoundary: vi.fn(() => openCode),
      createOpenCodeRuntimePermissionAnswerBoundary: vi.fn(() => openCode),
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    };
    const api = createTeamRuntimeControlCompatibilityApiFromService(service);

    const first = api.deliverOpenCodeRuntimeMessage(
      createDeliveryPayload({ idempotencyKey: '  message-key-1  ' })
    );
    await firstEntered.promise;
    const conflicting = api.deliverOpenCodeRuntimeMessage(
      createDeliveryPayload({ idempotencyKey: 'message-key-1', text: 'conflicting payload' })
    );

    expect(service.createOpenCodeRuntimeDeliveryBoundary).toHaveBeenCalledTimes(1);
    expect(openCode.deliverOpenCodeRuntimeMessage).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, conflicting])).resolves.toMatchObject([
      { state: 'delivered' },
      { state: 'duplicate' },
    ]);
    expect(service.createOpenCodeRuntimeDeliveryBoundary).toHaveBeenCalledTimes(2);
    expect(openCode.deliverOpenCodeRuntimeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: 'message-key-1',
        text: 'conflicting payload',
      })
    );
  });

  it('lets unrelated production compatibility delivery keys commit concurrently', async () => {
    const release = createDeferred();
    const enteredKeys = new Set<string>();
    const openCode = createOpenCodePort(createOpenCodeAck('accepted'));
    openCode.deliverOpenCodeRuntimeMessage = vi.fn(async (raw) => {
      const idempotencyKey = getPayloadIdempotencyKey(raw);
      enteredKeys.add(idempotencyKey);
      await release.promise;
      return createOpenCodeAck('delivered', { idempotencyKey });
    });
    const service = {
      createOpenCodeRuntimeDeliveryBoundary: vi.fn(() => openCode),
      createOpenCodeRuntimePermissionAnswerBoundary: vi.fn(() => openCode),
      resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    };
    const api = createTeamRuntimeControlCompatibilityApiFromService(service);
    const deliveries = [
      api.deliverOpenCodeRuntimeMessage(createDeliveryPayload()),
      api.deliverOpenCodeRuntimeMessage(createDeliveryPayload({ idempotencyKey: 'message-key-2' })),
    ];

    try {
      await vi.waitFor(() =>
        expect(enteredKeys).toEqual(new Set(['message-key-1', 'message-key-2']))
      );
    } finally {
      release.resolve();
    }

    await expect(Promise.all(deliveries)).resolves.toHaveLength(2);
    expect(service.createOpenCodeRuntimeDeliveryBoundary).toHaveBeenCalledTimes(2);
  });
});

function createOpenCodePort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
    answerOpenCodeRuntimePermission: vi.fn(async () => ack),
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

function createDeliveryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teamName: 'Team',
    runId: 'run-1',
    fromMemberName: 'Builder',
    idempotencyKey: 'message-key-1',
    runtimeSessionId: 'session-1',
    to: { memberName: 'Reviewer' },
    text: 'Delivered text',
    createdAt: OBSERVED_AT,
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

function getPayloadIdempotencyKey(raw: unknown): string {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('idempotencyKey' in raw) ||
    typeof raw.idempotencyKey !== 'string'
  ) {
    throw new Error('Expected delivery idempotency key');
  }
  return raw.idempotencyKey;
}
