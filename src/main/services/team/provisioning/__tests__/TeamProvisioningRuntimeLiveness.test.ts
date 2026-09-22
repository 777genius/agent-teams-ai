import { describe, expect, it } from 'vitest';

import { resolveTeamProvisioningRuntimeLiveness } from '../TeamProvisioningRuntimeLiveness';

const NOW = '2026-04-24T12:00:00.000Z';

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
