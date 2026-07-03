import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  rememberOpenCodeRuntimePidFromBridge,
  type RememberOpenCodeRuntimePidFromBridgeInput,
  type RememberOpenCodeRuntimePidFromBridgePorts,
} from '../TeamProvisioningOpenCodeRuntimePidBridge';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

const OBSERVED_AT = '2026-07-03T12:00:00.000Z';

function secondaryMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'alice',
    providerId: 'opencode',
    laneId: 'secondary:opencode:alice',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastEvaluatedAt: '2026-07-03T11:00:00.000Z',
    diagnostics: ['existing diagnostic'],
    sources: { nativeHeartbeat: true },
    ...overrides,
  };
}

function launchSnapshot(
  members: Record<string, PersistedTeamLaunchMemberState>
): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'team-a',
    expectedMembers: ['alice'],
    bootstrapExpectedMembers: ['alice'],
    launchPhase: 'active',
    members,
    updatedAt: '2026-07-03T11:00:00.000Z',
  });
}

function input(
  overrides: Partial<RememberOpenCodeRuntimePidFromBridgeInput> = {}
): RememberOpenCodeRuntimePidFromBridgeInput {
  return {
    teamName: 'team-a',
    memberName: 'alice',
    laneId: 'secondary:opencode:alice',
    runId: 'run-1',
    runtimeSessionId: 'session-1',
    runtimePid: 1234,
    reason: 'bridge registered runtime pid',
    ...overrides,
  };
}

function createPorts(
  snapshot: PersistedTeamLaunchSnapshot | null = launchSnapshot({
    alice: secondaryMember(),
  })
): {
  ports: RememberOpenCodeRuntimePidFromBridgePorts;
  getSnapshot: () => PersistedTeamLaunchSnapshot | null;
} {
  let currentSnapshot = snapshot;
  const ports: RememberOpenCodeRuntimePidFromBridgePorts = {
    nowIso: vi.fn(() => OBSERVED_AT),
    readProcessCommandByPid: vi.fn(() => 'opencode serve --hostname 127.0.0.1'),
    isOpenCodeServeCommand: vi.fn(() => true),
    enqueueLaunchStateStoreOperation: vi.fn(async (_teamName, operation) => operation()),
    readLaunchState: vi.fn(async () => currentSnapshot),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, nextSnapshot) => {
      currentSnapshot = nextSnapshot;
    }),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitTeamChange: vi.fn(),
    logDebug: vi.fn(),
  };
  return {
    ports,
    getSnapshot: () => currentSnapshot,
  };
}

describe('TeamProvisioningOpenCodeRuntimePidBridge', () => {
  it('ignores missing and invalid runtime pids before process lookup', async () => {
    const { ports } = createPorts();

    await rememberOpenCodeRuntimePidFromBridge(input({ runtimePid: undefined }), ports);
    await rememberOpenCodeRuntimePidFromBridge(input({ runtimePid: 0 }), ports);

    expect(ports.readProcessCommandByPid).not.toHaveBeenCalled();
    expect(ports.enqueueLaunchStateStoreOperation).not.toHaveBeenCalled();
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
  });

  it('ignores pids whose process command is missing or is not opencode serve', async () => {
    const { ports } = createPorts();
    vi.mocked(ports.readProcessCommandByPid).mockReturnValueOnce(null);
    await rememberOpenCodeRuntimePidFromBridge(input(), ports);

    vi.mocked(ports.readProcessCommandByPid).mockReturnValueOnce('node other.js');
    vi.mocked(ports.isOpenCodeServeCommand).mockReturnValueOnce(false);
    await rememberOpenCodeRuntimePidFromBridge(input({ runtimePid: 2345 }), ports);

    expect(ports.enqueueLaunchStateStoreOperation).not.toHaveBeenCalled();
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.logDebug).toHaveBeenCalledTimes(2);
  });

  it('updates runtime metadata and persisted launch state for a matching secondary lane member', async () => {
    const { ports, getSnapshot } = createPorts(
      launchSnapshot({
        alice: secondaryMember({
          runtimeDiagnostic: 'previous runtime diagnostic',
          runtimeRunId: 'run-1',
          runtimeSessionId: 'session-1',
        }),
      })
    );

    await rememberOpenCodeRuntimePidFromBridge(input(), ports);

    const member = getSnapshot()?.members.alice;
    expect(member).toMatchObject({
      runtimePid: 1234,
      runtimeRunId: 'run-1',
      runtimeSessionId: 'session-1',
      pidSource: 'opencode_bridge',
      lastRuntimeAliveAt: OBSERVED_AT,
      lastEvaluatedAt: OBSERVED_AT,
      sources: { nativeHeartbeat: true, processAlive: true },
    });
    expect(member?.diagnostics).toEqual([
      'existing diagnostic',
      'runtime pid: 1234',
      'bridge registered runtime pid',
      'previous runtime diagnostic',
    ]);
    expect(getSnapshot()?.updatedAt).toBe(OBSERVED_AT);
    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledOnce();
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('team-a');
    expect(ports.emitTeamChange).toHaveBeenCalledWith({
      type: 'member-spawn',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'alice',
    });
  });

  it('resolves the persisted member from lane identity when the storage key is not the member name', async () => {
    const { ports, getSnapshot } = createPorts(
      launchSnapshot({
        'secondary:opencode:alice': secondaryMember({
          name: 'secondary:opencode:alice',
        }),
      })
    );

    await rememberOpenCodeRuntimePidFromBridge(input(), ports);

    expect(getSnapshot()?.members['secondary:opencode:alice']?.runtimePid).toBe(1234);
    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledOnce();
  });

  it('does not rewrite launch state when the stored bridge pid is unchanged', async () => {
    const { ports } = createPorts(
      launchSnapshot({
        alice: secondaryMember({
          runtimePid: 1234,
          pidSource: 'opencode_bridge',
        }),
      })
    );

    await rememberOpenCodeRuntimePidFromBridge(input(), ports);

    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
  });

  it('does not update when launch state or member identity does not match', async () => {
    const noSnapshot = createPorts(null);
    await rememberOpenCodeRuntimePidFromBridge(input(), noSnapshot.ports);
    expect(noSnapshot.ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();

    const primaryMember = createPorts(
      launchSnapshot({
        alice: secondaryMember({
          laneKind: 'primary',
          laneOwnerProviderId: undefined,
          laneId: 'primary',
        }),
      })
    );
    await rememberOpenCodeRuntimePidFromBridge(input({ laneId: 'primary' }), primaryMember.ports);
    expect(primaryMember.ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();

    const mismatchedRun = createPorts(
      launchSnapshot({
        alice: secondaryMember({ runtimeRunId: 'other-run' }),
      })
    );
    await rememberOpenCodeRuntimePidFromBridge(input(), mismatchedRun.ports);
    expect(mismatchedRun.ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();

    const mismatchedSession = createPorts(
      launchSnapshot({
        alice: secondaryMember({ runtimeSessionId: 'other-session' }),
      })
    );
    await rememberOpenCodeRuntimePidFromBridge(input(), mismatchedSession.ports);
    expect(mismatchedSession.ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
  });

  it('logs and suppresses persistence errors', async () => {
    const { ports } = createPorts();
    vi.mocked(ports.writeLaunchStateSnapshot).mockRejectedValueOnce(new Error('write failed'));

    await expect(rememberOpenCodeRuntimePidFromBridge(input(), ports)).resolves.toBeUndefined();

    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.emitTeamChange).not.toHaveBeenCalled();
    expect(ports.logDebug).toHaveBeenCalledWith(
      '[team-a] Failed to persist OpenCode bridge runtime pid 1234 for alice: write failed'
    );
  });
});
