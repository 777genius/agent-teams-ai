import { describe, expect, it, vi } from 'vitest';

import { createTeamRuntimeControlCompatibilityApi } from '../index';

import type { OpenCodeRuntimeControlAck, OpenCodeRuntimeControlPort } from '../index';

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
});

function createOpenCodePort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
  };
}
