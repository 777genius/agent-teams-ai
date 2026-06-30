import { describe, expect, it } from 'vitest';

import {
  buildIncompleteLaunchCleanupReason,
  type IncompleteLaunchCleanupRun,
  shouldFinalizeIncompleteLaunchState,
} from '../TeamProvisioningCleanup';

function run(overrides: Partial<IncompleteLaunchCleanupRun> = {}): IncompleteLaunchCleanupRun {
  return {
    isLaunch: true,
    launchStateClearedForRun: true,
    provisioningComplete: false,
    cancelRequested: false,
    launchCleanupStateFinalized: false,
    progress: {
      state: 'spawning',
      message: '',
    },
    ...overrides,
  };
}

describe('team provisioning cleanup policy', () => {
  it('finalizes incomplete launch state only for unfinished active launch runs', () => {
    expect(shouldFinalizeIncompleteLaunchState(run())).toBe(true);
    expect(shouldFinalizeIncompleteLaunchState(run({ isLaunch: false }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ launchStateClearedForRun: false }))).toBe(
      false
    );
    expect(shouldFinalizeIncompleteLaunchState(run({ provisioningComplete: true }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ cancelRequested: true }))).toBe(false);
    expect(shouldFinalizeIncompleteLaunchState(run({ launchCleanupStateFinalized: true }))).toBe(
      false
    );
  });

  it('prefers explicit progress error, then failed progress message, then fallback reason', () => {
    expect(
      buildIncompleteLaunchCleanupReason(
        run({
          progress: {
            state: 'failed',
            message: 'failed message',
            error: ' explicit error ',
          },
        })
      )
    ).toBe('explicit error');

    expect(
      buildIncompleteLaunchCleanupReason(
        run({
          progress: {
            state: 'failed',
            message: ' failed message ',
          },
        })
      )
    ).toBe('failed message');

    expect(buildIncompleteLaunchCleanupReason(run(), 'fallback')).toBe('fallback');
  });
});
