import type { ProvisioningRun } from '@main/services/team/provisioning/TeamProvisioningRunModel';
import {
  clearCancelledAggregateRestartState,
  resolveAggregatePrimaryRestartCandidate,
} from '@main/services/team/provisioning/OpenCodeAggregatePrimaryRestartPolicy';
import { describe, expect, it, vi } from 'vitest';

describe('OpenCodeAggregatePrimaryRestartPolicy', () => {
  it('cleans every cancelled restart run without letting cleanup failures mask cancellation', async () => {
    const operations: string[] = [];
    const launchError = new Error('launch cleanup failed');
    const primaryError = new Error('primary cleanup failed');
    const onLaunchClearError = vi.fn<(runId: string, error: unknown) => void>();

    await expect(
      clearCancelledAggregateRestartState({
        runId: 'run-current',
        restartLease: {
          teamName: 'team-a',
          runId: 'run-current',
          candidateRunId: 'run-candidate',
          memberName: 'alice',
          completion: Promise.resolve(),
          precedingLifecycleOperations: [],
          cancelRequested: true,
        },
        clearLaunchState: async (runId) => {
          operations.push(`launch:${runId}`);
          if (runId === 'run-current') throw launchError;
        },
        clearPrimaryLane: async (runId) => {
          operations.push(`primary:${runId}`);
          if (runId === 'run-current') throw primaryError;
        },
        onLaunchClearError,
      })
    ).resolves.toBeUndefined();

    expect(operations).toEqual([
      'launch:run-current',
      'primary:run-current',
      'launch:run-candidate',
      'primary:run-candidate',
    ]);
    expect(onLaunchClearError.mock.calls).toEqual([
      ['run-current', launchError],
      ['run-current', primaryError],
    ]);
  });
});

describe('secondary retry isolation', () => {
  const run = {
    runId: 'run-current',
    processKilled: false,
    cancelRequested: false,
    mixedSecondaryLanes: [{ member: { name: 'alice' } }, { member: { name: 'bob' } }],
  } as ProvisioningRun;
  it('routes a tracked failed secondary to member-only recovery without modifying siblings', () => {
    const before = structuredClone(run);
    expect(
      resolveAggregatePrimaryRestartCandidate({
        runtimeRun: { runId: run.runId, providerId: 'opencode' },
        run,
        memberName: 'alice',
        expectedSecondary: true,
      })
    ).toBeNull();
    expect(run).toEqual(before);
  });
  it.each([null, { ...run, mixedSecondaryLanes: [] }, { ...run, processKilled: true }])(
    'rejects stale secondary ownership before aggregate routing (%j)',
    (candidate) => {
      expect(() =>
        resolveAggregatePrimaryRestartCandidate({
          runtimeRun: { runId: run.runId, providerId: 'opencode' },
          run: candidate,
          memberName: 'alice',
          expectedSecondary: true,
        })
      ).toThrow('refusing aggregate primary restart');
    }
  );
  it('preserves primary member routing', () => {
    expect(
      resolveAggregatePrimaryRestartCandidate({
        runtimeRun: { runId: run.runId, providerId: 'opencode' },
        run,
        memberName: 'primary-member',
      })
    ).toEqual({ runId: run.runId, run });
  });
});
