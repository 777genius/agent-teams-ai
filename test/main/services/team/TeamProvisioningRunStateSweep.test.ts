import { describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

import type { TeamProvisioningProgress } from '../../../../src/shared/types/team';

interface SweepInternals {
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  runtimeAdapterTraceLinesByRunId: Map<string, string[]>;
  runtimeAdapterTraceKeyByRunId: Map<string, string>;
  provisioningRunByTeam: Map<string, string>;
  sweepRuntimeAdapterRunState(nowMs?: number): void;
}

function buildProgress(runId: string, teamName: string, updatedAtMs: number): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state: 'failed',
    message: 'test',
    startedAt: new Date(updatedAtMs - 1000).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

describe('TeamProvisioningService runtime-adapter run-state sweep', () => {
  it('evicts stale unreferenced run state but keeps referenced and fresh runs', async () => {
    const service = new TeamProvisioningService();
    const internals = service as unknown as SweepInternals;

    const now = Date.now();
    const staleMs = now - 60 * 60_000;

    internals.runtimeAdapterProgressByRunId.set('stale-run', buildProgress('stale-run', 'team-a', staleMs));
    internals.runtimeAdapterTraceLinesByRunId.set('stale-run', ['line']);
    internals.runtimeAdapterTraceKeyByRunId.set('stale-run', 'key');

    internals.runtimeAdapterProgressByRunId.set('fresh-run', buildProgress('fresh-run', 'team-b', now));

    internals.runtimeAdapterProgressByRunId.set(
      'referenced-run',
      buildProgress('referenced-run', 'team-c', staleMs)
    );
    internals.provisioningRunByTeam.set('team-c', 'referenced-run');

    internals.sweepRuntimeAdapterRunState(now);

    expect(internals.runtimeAdapterProgressByRunId.has('stale-run')).toBe(false);
    expect(internals.runtimeAdapterTraceLinesByRunId.has('stale-run')).toBe(false);
    expect(internals.runtimeAdapterTraceKeyByRunId.has('stale-run')).toBe(false);

    expect(internals.runtimeAdapterProgressByRunId.has('fresh-run')).toBe(true);
    expect(internals.runtimeAdapterProgressByRunId.has('referenced-run')).toBe(true);

    // Evicted progress stays resolvable through the standard retention window.
    await expect(service.getProvisioningStatus('stale-run')).resolves.toMatchObject({
      runId: 'stale-run',
      state: 'failed',
    });
  });

  it('throttles repeated sweeps within the sweep interval', () => {
    const service = new TeamProvisioningService();
    const internals = service as unknown as SweepInternals;

    const now = Date.now();
    internals.sweepRuntimeAdapterRunState(now);

    const staleMs = now - 60 * 60_000;
    internals.runtimeAdapterProgressByRunId.set('stale-run', buildProgress('stale-run', 'team-a', staleMs));

    // Within the interval nothing is swept; past it the stale entry goes away.
    internals.sweepRuntimeAdapterRunState(now + 1000);
    expect(internals.runtimeAdapterProgressByRunId.has('stale-run')).toBe(true);

    internals.sweepRuntimeAdapterRunState(now + 2 * 60_000);
    expect(internals.runtimeAdapterProgressByRunId.has('stale-run')).toBe(false);
  });
});
