import { describe, expect, it } from 'vitest';

import { isRuntimeBootstrapTransportEventCurrent } from '../TeamProvisioningBootstrapTranscript';
import { createUpdateDirectTmuxRestartMemberConfigUseCase } from '../TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';

const timestamp = '2026-11-16T22:00:00.000Z';
const boundaryMs = Date.parse('2026-11-16T21:59:00.000Z');
const currentEvent = {
  type: 'bootstrap_submitted',
  teamName: 'demo',
  agentName: 'bob',
  agentId: 'bob@demo',
  timestamp,
  bootstrapRunId: 'attempt-one',
};

function qualifies(pid: number, options: {
  wrapped?: boolean;
  runId?: string | null;
  teamName?: string;
  timestamp?: string;
} = {}): boolean {
  const { wrapped = false, runId = 'attempt-one', ...rest } = options;
  const event = {
    ...currentEvent,
    pid,
    ...(runId === null ? { bootstrapRunId: undefined } : { bootstrapRunId: runId }),
    ...rest,
  };
  return isRuntimeBootstrapTransportEventCurrent({
    event,
    teamName: 'demo',
    memberName: 'bob',
    runtimeMember: { name: 'bob', agentId: 'bob@demo' },
    expectedPid: 5012,
    expectedBootstrapRunId: 'attempt-one',
    allowWrapperChildPidWithRunId: wrapped,
    boundaryMs,
  });
}

describe('Windows wrapped process bootstrap transport identity', () => {
  it('retains strict matching for non-wrapper process backends', () => {
    expect(qualifies(5012)).toBe(true);
    expect(qualifies(824)).toBe(false);
  });

  it('accepts an actual child PID only with an exact nonempty bootstrap run ID', () => {
    expect(qualifies(5012, { wrapped: true })).toBe(true);
    expect(qualifies(824, { wrapped: true })).toBe(true);
    expect(qualifies(824, { wrapped: true, runId: null })).toBe(false);
    expect(qualifies(824, { wrapped: true, runId: 'prior-attempt' })).toBe(false);
  });

  it('rejects foreign teams and events predating the current attempt', () => {
    expect(qualifies(824, { wrapped: true, teamName: 'other-team' })).toBe(false);
    expect(qualifies(824, { wrapped: true, timestamp: '2026-11-16T21:00:00.000Z' })).toBe(false);
  });
});

describe('Windows native Job wrapper PID metadata', () => {
  it('writes wrapper role only for wrapped launches and clears it on unwrapped restart', async () => {
    let raw = JSON.stringify({ name: 'demo', members: [{ name: 'bob', backendType: 'process' }] });
    const update = createUpdateDirectTmuxRestartMemberConfigUseCase({
      async readTeamConfigJson() { return raw; },
      async writeTeamConfigJson(_name, contents) { raw = contents; },
      invalidateTeamConfig() {},
    });
    const input = {
      teamName: 'demo',
      memberName: 'bob',
      member: { name: 'bob', providerId: 'codex' as const },
      agentId: 'bob@demo',
      color: 'blue',
      prompt: 'bootstrap',
      paneId: 'process:5012',
      cwd: '/fixture',
      providerId: 'codex' as const,
      joinedAt: 1,
      bootstrapExpectedAfter: timestamp,
      backendType: 'process' as const,
      runtimePid: 5012,
    };
    await update({ ...input, runtimePidRole: 'wrapper' });
    expect(JSON.parse(raw).members[0].runtimePidRole).toBe('wrapper');
    await update({ ...input, runtimePidRole: undefined });
    expect(JSON.parse(raw).members[0].runtimePidRole).toBeUndefined();
  });
});
