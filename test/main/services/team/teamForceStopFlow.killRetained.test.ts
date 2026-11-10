import {
  killRetainedOpenCodeRuntimeProcessesForTeam,
  runTeamForceStopFlow,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ kill: vi.fn(), sweep: vi.fn() }));
vi.mock('@main/utils/processKill', () => ({
  killProcessByPid: effects.kill,
  killProcessByPidAndWait: effects.kill,
}));
vi.mock('@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup', () => ({
  cleanupManagedOpenCodeServeProcesses: effects.sweep,
}));

describe('force cleanup of shared OpenCode hosts', () => {
  it.each([{ otherAliveTeams: [] }, { otherAliveTeams: ['other-team'] }])(
    'does not signal hosts when other alive teams are %j',
    async ({ otherAliveTeams }) => {
      const result = await killRetainedOpenCodeRuntimeProcessesForTeam({
        teamName: 'sandbox',
        otherAliveTeams,
      });
      expect(result).toMatchObject({ killedPids: [], incomplete: true });
      expect(result.diagnostics.join(' ')).toContain('sharing an OpenCode host');
      expect(effects.kill).not.toHaveBeenCalled();
      expect(effects.sweep).not.toHaveBeenCalled();
    }
  );

  it('completes confirmed scoped stop without requiring shared host termination', async () => {
    const clear = vi.fn(() => Promise.resolve({ cleared: 2, diagnostics: [] }));
    const result = await runTeamForceStopFlow('sandbox', {
      stopTeam: () => Promise.resolve(),
      observeOwnedRuntimeRunIds: () => Promise.resolve(['run-a']),
      killRetainedRuntimeProcesses: (teamName, context) =>
        killRetainedOpenCodeRuntimeProcessesForTeam({ teamName, ...context, otherAliveTeams: [] }),
      clearPendingPromptDeliveries: clear,
      logWarning: vi.fn(),
    });
    expect(result).toMatchObject({
      stopOutcome: 'stopped',
      cleanupOutcome: 'completed',
      killedRuntimePids: [],
      clearedPendingDeliveries: 2,
    });
    expect(result.diagnostics).toEqual([]);
    expect(clear).toHaveBeenCalledWith('sandbox', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
  });
  it.each(['failed', 'timeout'] as const)(
    'retains incomplete for %s scoped stop',
    async (outcome) => {
      const result = await runTeamForceStopFlow('sandbox', {
        stopTeam: () =>
          outcome === 'failed'
            ? Promise.reject(new Error('retained'))
            : new Promise<void>(() => undefined),
        observeOwnedRuntimeRunIds: () => Promise.resolve(['run-a']),
        killRetainedRuntimeProcesses: (teamName, context) =>
          killRetainedOpenCodeRuntimeProcessesForTeam({
            teamName,
            ...context,
            otherAliveTeams: [],
          }),
        clearPendingPromptDeliveries: () => Promise.resolve({ cleared: 1, diagnostics: [] }),
        logWarning: vi.fn(),
        stopTimeoutMs: 1,
      });
      expect(result.cleanupOutcome).toBe('incomplete');
      expect(result.clearedPendingDeliveries).toBe(1);
      expect(result.diagnostics.join(' ')).toContain('Hard process cleanup is not confirmed');
    }
  );
  it('reports partial delivery cleanup after successful scoped stop', async () => {
    const hardCleanup = vi.fn();
    const result = await runTeamForceStopFlow('sandbox', {
      stopTeam: () => Promise.resolve(),
      observeOwnedRuntimeRunIds: () => Promise.resolve(['run-a']),
      killRetainedRuntimeProcesses: hardCleanup,
      clearPendingPromptDeliveries: () =>
        Promise.resolve({
          cleared: 0,
          diagnostics: ['Failed to cancel pending deliveries for lane primary'],
        }),
      logWarning: vi.fn(),
    });
    expect(result.cleanupOutcome).toBe('incomplete');
    expect(hardCleanup).not.toHaveBeenCalled();
  });
});
