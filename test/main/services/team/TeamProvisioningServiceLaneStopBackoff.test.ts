import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { TeamProvisioningOpenCodeStoppedLaneCleanupBoundary } from '../../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-lane-stop-backoff-'));
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'user-data'));
});

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe('TeamProvisioningService lane stop backoff', () => {
  function internalsOf(service: TeamProvisioningService): {
    openCodeStoppedLaneCleanup: TeamProvisioningOpenCodeStoppedLaneCleanupBoundary;
    stopFlowBoundary: { stopTeam(teamName: string): Promise<void> };
  } {
    return service as unknown as {
      openCodeStoppedLaneCleanup: TeamProvisioningOpenCodeStoppedLaneCleanupBoundary;
      stopFlowBoundary: { stopTeam(teamName: string): Promise<void> };
    };
  }

  it('clearStoppedLaneStopBackoff forgets the team in the stopped lane cleanup', () => {
    const service = new TeamProvisioningService();
    const clearStopBackoff = vi.spyOn(
      internalsOf(service).openCodeStoppedLaneCleanup,
      'clearStopBackoff'
    );

    service.clearStoppedLaneStopBackoff('trashed-team');

    expect(clearStopBackoff).toHaveBeenCalledWith('trashed-team');
  });

  it('stopTeam leaves the backoff alone, so Move to trash cannot open the lock to a background pass', async () => {
    const service = new TeamProvisioningService();
    const internals = internalsOf(service);
    const clearStopBackoff = vi.spyOn(internals.openCodeStoppedLaneCleanup, 'clearStopBackoff');
    // Only the wiring is under test here; the stop flow itself has its own tests.
    const stopFlow = vi.spyOn(internals.stopFlowBoundary, 'stopTeam').mockResolvedValue(undefined);

    await service.stopTeam('stopped-team');

    expect(stopFlow).toHaveBeenCalledWith('stopped-team');
    expect(clearStopBackoff).not.toHaveBeenCalled();
  });
});
