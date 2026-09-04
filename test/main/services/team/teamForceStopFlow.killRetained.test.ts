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

  it('reports unsupported hard cleanup even when scoped stop succeeds, and cancels deliveries', async () => {
    const clear = vi.fn(async () => ({ cleared: 2, diagnostics: [] }));
    const result = await runTeamForceStopFlow('sandbox', {
      stopTeam: async () => {},
      observeOwnedRuntimeRunIds: async () => ['run-a'],
      killRetainedRuntimeProcesses: (teamName, context) =>
        killRetainedOpenCodeRuntimeProcessesForTeam({ teamName, ...context, otherAliveTeams: [] }),
      clearPendingPromptDeliveries: clear,
      logWarning: vi.fn(),
    });
    expect(result).toMatchObject({
      stopOutcome: 'stopped',
      cleanupOutcome: 'incomplete',
      killedRuntimePids: [],
      clearedPendingDeliveries: 2,
    });
    expect(clear).toHaveBeenCalledWith('sandbox', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
  });
});
