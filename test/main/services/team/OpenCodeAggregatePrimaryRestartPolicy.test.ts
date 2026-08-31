import { clearCancelledAggregateRestartState } from '@main/services/team/provisioning/OpenCodeAggregatePrimaryRestartPolicy';
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
