import { describe, expect, it } from 'vitest';

import { resolveTeamProvisioningRuntimeSnapshotLiveness } from '../TeamProvisioningRuntimeSnapshotResolver';

describe('TeamProvisioningRuntimeSnapshotResolver', () => {
  it.each([{ confirmedRuntimeBootstrapAlive: true }, { confirmedSpawnRuntimeFallback: true }])(
    'keeps live permission evidence ahead of raw confirmation',
    (confirmation) => {
      expect(
        resolveTeamProvisioningRuntimeSnapshotLiveness({
          liveAlive: false,
          liveLivenessKind: 'permission_blocked',
          liveRuntimeDiagnostic: 'waiting for permission approval',
          liveRuntimeDiagnosticSeverity: 'warning',
          ...confirmation,
        })
      ).toEqual({
        alive: false,
        livenessKind: 'permission_blocked',
        runtimeDiagnostic: 'waiting for permission approval',
        runtimeDiagnosticSeverity: 'warning',
      });
    }
  );

  it('projects source-level permission evidence ahead of weak live metadata', () => {
    expect(
      resolveTeamProvisioningRuntimeSnapshotLiveness({
        liveAlive: false,
        liveLivenessKind: 'registered_only',
        livePidSource: 'persisted_metadata',
        confirmedRuntimeBootstrapAlive: true,
        permissionBlocked: true,
      })
    ).toEqual({
      alive: false,
      livenessKind: 'permission_blocked',
      runtimeDiagnostic: 'waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('preserves confirmed spawn fallback behavior without permission evidence', () => {
    expect(
      resolveTeamProvisioningRuntimeSnapshotLiveness({
        liveAlive: false,
        liveLivenessKind: 'registered_only',
        livePidSource: 'persisted_metadata',
        confirmedSpawnRuntimeFallback: true,
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeDiagnostic: 'bootstrap confirmed',
      runtimeDiagnosticSeverity: 'info',
    });
  });
});
