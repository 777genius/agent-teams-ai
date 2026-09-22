import {
  type TeamProvisioningTurnCompleteRun,
  writeTeammateLaunchFailureArtifactPackIfNeeded,
} from '@main/services/team/provisioning/TeamProvisioningTurnComplete';
import { describe, expect, it, vi } from 'vitest';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

describe('TeamProvisioningTurnComplete failure artifacts', () => {
  it.each([
    [true, 'launch_completed_with_teammate_errors'],
    [false, 'provisioning_completed_with_teammate_errors'],
  ] as const)('writes a partial-failure artifact pack when isLaunch=%s', (isLaunch, reason) => {
    const run = { isLaunch } as TeamProvisioningTurnCompleteRun;
    const launchSnapshot = { version: 2 } as PersistedTeamLaunchSnapshot;
    const writeLaunchFailureArtifactPackBestEffort = vi.fn();

    writeTeammateLaunchFailureArtifactPackIfNeeded(run, true, launchSnapshot, {
      writeLaunchFailureArtifactPackBestEffort,
    });

    expect(writeLaunchFailureArtifactPackBestEffort).toHaveBeenCalledWith(run, {
      reason,
      launchSnapshot,
    });
  });

  it('does not write an artifact pack for a clean launch', () => {
    const run = { isLaunch: true } as TeamProvisioningTurnCompleteRun;
    const writeLaunchFailureArtifactPackBestEffort = vi.fn();

    writeTeammateLaunchFailureArtifactPackIfNeeded(run, false, null, {
      writeLaunchFailureArtifactPackBestEffort,
    });

    expect(writeLaunchFailureArtifactPackBestEffort).not.toHaveBeenCalled();
  });
});
