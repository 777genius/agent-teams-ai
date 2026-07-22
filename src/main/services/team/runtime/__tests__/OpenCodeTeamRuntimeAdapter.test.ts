import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
} from '../OpenCodeTeamRuntimeAdapter';

import type { TeamRuntimePermissionAnswerInput } from '../TeamRuntimeAdapter';

describe('OpenCodeTeamRuntimeAdapter runtime permission messages', () => {
  it('includes a supplied message in the final OpenCode bridge payload', async () => {
    const { adapter, answerOpenCodeRuntimePermission } = createHarness();

    await adapter.answerRuntimePermission({
      ...permissionInput(),
      message: 'Approved for the requested test command.',
    });

    expect(answerOpenCodeRuntimePermission).toHaveBeenCalledWith({
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'Worker',
      requestId: 'permission-1',
      decision: 'allow',
      message: 'Approved for the requested test command.',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });
  });

  it('leaves the legacy bridge payload unchanged when message is undefined', async () => {
    const { adapter, answerOpenCodeRuntimePermission } = createHarness();

    await adapter.answerRuntimePermission(permissionInput());

    const bridgePayload = answerOpenCodeRuntimePermission.mock.calls[0]?.[0];
    expect(bridgePayload).toEqual({
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'Worker',
      requestId: 'permission-1',
      decision: 'allow',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });
    expect(Object.hasOwn(bridgePayload ?? {}, 'message')).toBe(false);
  });
});

function createHarness() {
  const answerOpenCodeRuntimePermission = vi.fn<
    NonNullable<OpenCodeTeamRuntimeBridgePort['answerOpenCodeRuntimePermission']>
  >(async (_input) => ({
    runId: 'run-1',
    teamLaunchState: 'ready',
    members: {},
    warnings: [],
    diagnostics: [],
  }));
  const bridge = {
    answerOpenCodeRuntimePermission,
  } as unknown as OpenCodeTeamRuntimeBridgePort;
  return {
    adapter: new OpenCodeTeamRuntimeAdapter(bridge),
    answerOpenCodeRuntimePermission,
  };
}

function permissionInput(): TeamRuntimePermissionAnswerInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    laneId: 'primary',
    cwd: '/repo',
    providerId: 'opencode',
    memberName: 'Worker',
    requestId: 'permission-1',
    decision: 'allow',
    expectedMembers: [],
    previousLaunchState: null,
  };
}
