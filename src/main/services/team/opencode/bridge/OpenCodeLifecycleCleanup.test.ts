import { describe, expect, it, vi } from 'vitest';

import { cleanupLegacyOpenCodeLifecycle } from './OpenCodeLifecycleCleanup';
import { runOpenCodeLifecycleCleanupTail } from './OpenCodeLifecycleCleanupTail';

import type { OpenCodeCleanupHostsCommandData } from './OpenCodeBridgeCommandContract';

vi.mock('./OpenCodeLifecycleCleanupTail', () => ({
  runOpenCodeLifecycleCleanupTail: vi.fn(async () => {}),
}));

describe('owner-scoped native registry maintenance', () => {
  it.each(['startup', 'shutdown'] as const)(
    'skips %s native dispatch only for proven absence, preserving fallback fences',
    async (reason) => {
      const bridge = { cleanupOpenCodeHosts: vi.fn() };
      await cleanupLegacyOpenCodeLifecycle({
        reason,
        bridge,
        nativeMaintenanceRequired: async () => false,
        appStartedAtMs: 123,
        managedHostInstanceId: 'captured-instance',
        profileScope: 'captured-profile',
        logInfo: vi.fn(),
        ports: { logSweepResult: vi.fn(), logWarning: vi.fn(), logError: vi.fn() },
      });
      expect(bridge.cleanupOpenCodeHosts).not.toHaveBeenCalled();
      expect(runOpenCodeLifecycleCleanupTail).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reason,
          registryMaintenanceSkipped: true,
          registryCleanupAvailable: true,
          appStartedAtMs: 123,
          managedHostInstanceId: 'captured-instance',
          profileScope: 'captured-profile',
        })
      );
    }
  );

  it('retains the original native cleanup and kept-PID handling for legacy work', async () => {
    const bridge = {
      cleanupOpenCodeHosts: vi.fn(
        async (): Promise<OpenCodeCleanupHostsCommandData> => ({
          cleaned: 0,
          remaining: 1,
          diagnostics: [],
          hosts: [
            {
              action: 'kept_active',
              pid: 42,
              hostKey: 'legacy',
              projectPath: '/TEST-workspace',
              port: 12345,
              reason: 'active',
              leaseCount: 1,
            },
          ],
        })
      ),
    };
    await cleanupLegacyOpenCodeLifecycle({
      reason: 'startup',
      bridge,
      nativeMaintenanceRequired: async () => true,
      appStartedAtMs: 123,
      managedHostInstanceId: 'captured-instance',
      logInfo: vi.fn(),
      ports: { logSweepResult: vi.fn(), logWarning: vi.fn(), logError: vi.fn() },
    });
    expect(bridge.cleanupOpenCodeHosts).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'startup', mode: 'stale' })
    );
    expect(runOpenCodeLifecycleCleanupTail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registryMaintenanceSkipped: false,
        registryHostPids: new Set([42]),
        registryCleanupAvailable: true,
      })
    );
  });
});
