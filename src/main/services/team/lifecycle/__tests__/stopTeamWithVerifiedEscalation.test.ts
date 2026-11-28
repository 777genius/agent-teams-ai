import { describe, expect, it, vi } from 'vitest';

import { stopTeamWithVerifiedEscalation } from '../stopTeamWithVerifiedEscalation';

import type { TeamForceStopResult } from '@shared/types';

const runStopFlow = vi.hoisted(() => vi.fn());
vi.mock('../teamForceStopFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../teamForceStopFlow')>()),
  stopTeamWithEscalation: runStopFlow,
}));

function outcome(
  stopOutcome: TeamForceStopResult['stopOutcome'],
  cleanupOutcome: TeamForceStopResult['cleanupOutcome']
): TeamForceStopResult {
  return {
    stopOutcome,
    cleanupOutcome,
    killedRuntimePids: [],
    clearedPendingDeliveries: 0,
    diagnostics: [],
  };
}

describe('shared exact-team stop escalation', () => {
  it('delegates native stop through the bounded flow and requires confirmation', async () => {
    const stopped = vi.fn(async () => undefined);
    const runtime = {
      stopTeam: stopped,
      getAliveTeams: () => ['alpha'],
    };
    runStopFlow.mockImplementationOnce(
      async (
        name: string,
        ports: { stopTeam(teamName: string): Promise<void>; stopTimeoutMs?: number }
      ) => {
        expect(name).toBe('alpha');
        expect(ports.stopTimeoutMs).toBeGreaterThan(0);
        await ports.stopTeam(name);
        return outcome('stopped', 'completed');
      }
    );
    await expect(
      stopTeamWithVerifiedEscalation('alpha', runtime, {
        warn: vi.fn(),
      })
    ).resolves.toBeUndefined();
    expect(stopped).toHaveBeenCalledExactlyOnceWith('alpha');
  });

  it('refuses to report success for incomplete native cleanup', async () => {
    const warned = vi.fn();
    runStopFlow.mockResolvedValueOnce(outcome('timed_out', 'incomplete'));
    await expect(
      stopTeamWithVerifiedEscalation(
        'alpha',
        {
          stopTeam: vi.fn(async () => undefined),
          getAliveTeams: () => ['alpha'],
        },
        { warn: warned }
      )
    ).rejects.toThrow('team_stop_unconfirmed:timed_out');
    expect(warned).toHaveBeenCalled();
  });
});
