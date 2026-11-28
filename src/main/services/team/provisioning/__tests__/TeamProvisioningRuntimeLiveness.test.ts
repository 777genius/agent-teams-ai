import { describe, expect, it } from 'vitest';

import { resolveTeamProvisioningRuntimeLiveness } from '../TeamProvisioningRuntimeLiveness';
import { resolveTeamProvisioningRuntimeSnapshotLiveness } from '../TeamProvisioningRuntimeSnapshotResolver';

const NOW = '2026-04-24T12:00:00.000Z';

function failedOpenCodeRegistration(): Parameters<
  typeof resolveTeamProvisioningRuntimeLiveness
>[0] {
  return {
    teamName: 'TEST-failed-opencode-registration',
    memberName: 'bob',
    providerId: 'opencode',
    // Persisted OpenCode launch members receive this backend even if native
    // startup failed before any pid, session, or lane was committed.
    backendType: 'process',
    trackedSpawnStatus: {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'native_owner_retired:execution_selected_auth_anonymous_unproven',
      updatedAt: NOW,
    },
    processRows: [],
    processTableAvailable: true,
    nowIso: NOW,
  };
}

function resolveWithHeartbeat(lastHeartbeatAt: string) {
  return resolveTeamProvisioningRuntimeLiveness({
    teamName: 'demo',
    memberName: 'worker',
    backendType: 'process',
    trackedSpawnStatus: {
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt,
      updatedAt: NOW,
    },
    processRows: [],
    processTableAvailable: true,
    nowIso: NOW,
  });
}

describe('TeamProvisioningRuntimeLiveness', () => {
  it.each([
    { hardFailure: true, launchState: 'failed_to_start' as const },
    { hardFailure: false, launchState: 'failed_to_start' as const },
    { hardFailure: true, launchState: 'runtime_pending_bootstrap' as const },
  ])('does not report failed OpenCode registration as alive: %j', (failure) => {
    const input = failedOpenCodeRegistration();
    input.trackedSpawnStatus = { ...input.trackedSpawnStatus!, ...failure };
    const live = resolveTeamProvisioningRuntimeLiveness(input);
    const snapshot = resolveTeamProvisioningRuntimeSnapshotLiveness({
      liveAlive: live.alive,
      liveLivenessKind: live.livenessKind,
      liveRuntimeDiagnostic: live.runtimeDiagnostic,
      confirmedRuntimeBootstrapAlive: false,
      confirmedSpawnRuntimeFallback: false,
    });

    expect(snapshot).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: input.trackedSpawnStatus.hardFailureReason,
    });
  });

  it('does not revive a failed registration when its recorded pid cannot be checked', () => {
    const live = resolveTeamProvisioningRuntimeLiveness({
      ...failedOpenCodeRegistration(),
      persistedRuntimePid: 444,
      processTableAvailable: false,
    });

    expect(live).toMatchObject({ alive: false, livenessKind: 'registered_only' });
    expect(live.diagnostics).toContain('process table unavailable');
  });

  it.each(['starting', 'runtime_pending_bootstrap'] as const)(
    'keeps ordinary %s registration eligible while no failure contradicts it',
    (launchState) => {
      const input = failedOpenCodeRegistration();
      input.trackedSpawnStatus = {
        ...input.trackedSpawnStatus!,
        status: 'spawning',
        launchState,
        hardFailure: false,
        hardFailureReason: undefined,
      };

      expect(resolveTeamProvisioningRuntimeLiveness(input)).toMatchObject({
        alive: true,
        livenessKind: 'registered_only',
      });
    }
  );

  it('retains a verified runtime process even when the launch gate reports failure', () => {
    const input = failedOpenCodeRegistration();
    input.agentId = 'agent-bob';
    input.processRows = [
      {
        pid: 222,
        ppid: 1,
        command: `node runtime --team-name ${input.teamName} --agent-id agent-bob`,
      },
    ];

    expect(resolveTeamProvisioningRuntimeLiveness(input)).toMatchObject({
      alive: true,
      livenessKind: 'runtime_process',
      pid: 222,
    });
  });

  it('accepts a valid fresh bootstrap timestamp', () => {
    expect(resolveWithHeartbeat(NOW)).toMatchObject({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      runtimeLastSeenAt: NOW,
      runtimeDiagnostic: 'bootstrap confirmed',
    });
  });

  it('keeps a future bootstrap timestamp registered-only', () => {
    expect(resolveWithHeartbeat('2026-04-24T12:00:00.001Z')).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      pidSource: 'runtime_bootstrap',
      runtimeLastSeenAt: '2026-04-24T12:00:00.001Z',
      runtimeDiagnostic: 'runtime heartbeat timestamp is in the future',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('keeps permission evidence ahead of a raw bootstrap confirmation', () => {
    const result = resolveTeamProvisioningRuntimeLiveness({
      teamName: 'demo',
      memberName: 'worker',
      backendType: 'process',
      trackedSpawnStatus: {
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        pendingPermissionRequestIds: ['permission-1'],
        lastHeartbeatAt: NOW,
        updatedAt: NOW,
      },
      processRows: [
        { pid: 222, ppid: 1, command: 'node runtime.js --team-name demo --agent-id worker' },
      ],
      processTableAvailable: true,
      agentId: 'worker',
      nowIso: NOW,
    });

    expect(result).toMatchObject({
      alive: false,
      livenessKind: 'permission_blocked',
      runtimeDiagnostic: 'waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
    });
  });
});
