import { describe, expect, it } from 'vitest';

import { shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange } from '../TeamProvisioningOpenCodeRuntimeLivenessPolicy';

import type { PersistedTeamLaunchMemberState } from '@shared/types';

function createConfirmedMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'builder',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    runtimeRunId: 'run-1',
    runtimeSessionId: 'session-1',
    runtimePid: 1234,
    lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeRuntimeLivenessPolicy', () => {
  it('emits when there is no previous persisted member', () => {
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-1',
      })
    ).toBe(true);
  });

  it('does not emit for the same healthy runtime observation', () => {
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember(),
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-1',
        runtimePid: 1234,
      })
    ).toBe(false);
  });

  it('emits when runtime identity changes', () => {
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember(),
        runtimeRunId: 'run-2',
        runtimeSessionId: 'session-1',
        runtimePid: 1234,
      })
    ).toBe(true);
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember(),
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-2',
        runtimePid: 1234,
      })
    ).toBe(true);
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember(),
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-1',
        runtimePid: 5678,
      })
    ).toBe(true);
  });

  it('emits when the previous member was not healthy confirmed alive', () => {
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember({ runtimeAlive: false }),
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-1',
        runtimePid: 1234,
      })
    ).toBe(true);
    expect(
      shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
        previousMember: createConfirmedMember({ hardFailure: true }),
        runtimeRunId: 'run-1',
        runtimeSessionId: 'session-1',
        runtimePid: 1234,
      })
    ).toBe(true);
  });
});
