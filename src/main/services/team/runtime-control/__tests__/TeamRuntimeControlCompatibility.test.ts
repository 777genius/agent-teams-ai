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
});

function createOpenCodePort(ack: OpenCodeRuntimeControlAck): OpenCodeRuntimeControlPort {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
    deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
  };
}
