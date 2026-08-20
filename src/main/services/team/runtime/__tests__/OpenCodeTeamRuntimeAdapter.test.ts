import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
} from '../OpenCodeTeamRuntimeAdapter';

import type { OpenCodeTeamLaunchReadiness } from '../../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  TeamRuntimeLaunchInput,
  TeamRuntimePermissionAnswerInput,
} from '../TeamRuntimeAdapter';

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

describe('OpenCodeTeamRuntimeAdapter launch readiness', () => {
  it('refreshes a reusable execution proof before a state-changing launch', async () => {
    const temporarilyUnavailable = readiness({
      launchAllowed: false,
      state: 'unknown_error',
      diagnostics: ['OpenCode provider is temporarily unavailable. Retry shortly.'],
    });
    const checkOpenCodeTeamLaunchReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(readiness({ launchAllowed: true, state: 'ready' }))
      .mockResolvedValueOnce(temporarilyUnavailable);
    const launchOpenCodeTeam =
      vi.fn<NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>>();
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness,
      launchOpenCodeTeam,
    });
    const input = launchInput();

    await expect(adapter.prepare(input)).resolves.toMatchObject({ ok: true });
    const result = await adapter.launch(input);

    expect(checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result.diagnostics).toContain(temporarilyUnavailable.diagnostics[0]);
    expect(result.members.Worker?.hardFailureReason).toBe(
      'OpenCode is temporarily unavailable. Retry the launch.'
    );
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

function readiness({
  launchAllowed,
  state,
  diagnostics = [],
}: Pick<OpenCodeTeamLaunchReadiness, 'launchAllowed' | 'state'> & {
  diagnostics?: string[];
}): OpenCodeTeamLaunchReadiness {
  const modelId = 'deepinfra/model';
  return {
    state,
    launchAllowed,
    modelId,
    availableModels: [modelId],
    opencodeVersion: '1.18.11',
    installMethod: 'npm',
    binaryPath: '/usr/local/bin/opencode',
    hostHealthy: launchAllowed,
    appMcpConnected: launchAllowed,
    requiredToolsPresent: launchAllowed,
    permissionBridgeReady: launchAllowed,
    runtimeStoresReady: launchAllowed,
    supportLevel: launchAllowed ? 'production_supported' : null,
    missing: [],
    diagnostics,
    evidence: {
      capabilitiesReady: launchAllowed,
      mcpToolProofRoute: null,
      observedMcpTools: [],
      runtimeStoreReadinessReason: null,
    },
    ...(launchAllowed
      ? {
          executionProof: {
            schemaVersion: 1,
            providerId: 'opencode',
            modelId,
            projectPath: '/repo',
            profileRootKey: 'profile',
            projectBehaviorFingerprint: 'project',
            managedConfigFingerprint: 'config',
            managedAuthFingerprint: 'auth',
            binaryPath: '/usr/local/bin/opencode',
            binaryFingerprint: 'binary',
            opencodeVersion: '1.18.11',
            capabilitySnapshotId: 'capability-1',
            credentialMode: 'api',
            reusable: true,
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            proofHash: 'proof',
          },
        }
      : {}),
  };
}

function launchInput(): TeamRuntimeLaunchInput {
  return {
    runId: 'run-launch',
    teamName: 'team-launch',
    cwd: '/repo',
    providerId: 'opencode',
    model: 'deepinfra/model',
    skipPermissions: true,
    expectedMembers: [
      {
        name: 'Worker',
        role: 'worker',
        workflow: 'Implement the task',
        cwd: '/repo',
        providerId: 'opencode',
        model: 'deepinfra/model',
      },
    ],
    previousLaunchState: null,
  };
}
