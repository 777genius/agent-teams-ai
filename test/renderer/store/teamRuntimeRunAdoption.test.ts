import { describe, expect, it } from 'vitest';

import {
  isPinnedRuntimeRunFullyStopped,
  resolveIncomingRuntimeRunAdoption,
  shouldAdoptSuccessorProvisioningRun,
} from '../../../src/renderer/store/team/teamRuntimeRunAdoption';

describe('teamRuntimeRunAdoption', () => {
  it('treats empty spawn maps as not fully stopped', () => {
    expect(isPinnedRuntimeRunFullyStopped(undefined)).toBe(false);
    expect(isPinnedRuntimeRunFullyStopped({})).toBe(false);
  });

  it('treats overlay offline and failed members as fully stopped', () => {
    expect(
      isPinnedRuntimeRunFullyStopped({
        alice: { status: 'offline', runtimeAlive: false },
        oscar: { status: 'error', runtimeAlive: false },
      })
    ).toBe(true);
  });

  it('does not treat stale-runtime confirmed members as stopped', () => {
    expect(
      isPinnedRuntimeRunFullyStopped({
        alice: { status: 'online', runtimeAlive: false },
      })
    ).toBe(false);
  });

  it('rejects ignored snapshots even when the pinned run is stopped', () => {
    expect(
      resolveIncomingRuntimeRunAdoption({
        teamName: 'my-team',
        snapshotRunId: 'run-new',
        currentRuntimeRunId: 'run-old',
        ignoredRuntimeRunIds: { 'run-new': 'my-team' },
        pinnedSpawnStatuses: { alice: { status: 'offline', runtimeAlive: false } },
      })
    ).toBe('reject');
  });

  it('retargets a live successor when the pinned run is fully stopped', () => {
    expect(
      resolveIncomingRuntimeRunAdoption({
        teamName: 'my-team',
        snapshotRunId: 'run-new',
        currentRuntimeRunId: 'run-old',
        ignoredRuntimeRunIds: {},
        pinnedSpawnStatuses: { alice: { status: 'offline', runtimeAlive: false } },
      })
    ).toBe('retarget');
  });

  it('keeps dropping a different live run while members are still online', () => {
    expect(
      resolveIncomingRuntimeRunAdoption({
        teamName: 'my-team',
        snapshotRunId: 'run-old',
        currentRuntimeRunId: 'run-new',
        ignoredRuntimeRunIds: {},
        pinnedSpawnStatuses: { alice: { status: 'online', runtimeAlive: true } },
      })
    ).toBe('reject');
  });

  it('keeps the offline+unpinned zombie guard', () => {
    expect(
      resolveIncomingRuntimeRunAdoption({
        teamName: 'my-team',
        snapshotRunId: 'run-old',
        currentRuntimeRunId: null,
        ignoredRuntimeRunIds: {},
        leadActivity: 'offline',
      })
    ).toBe('reject');
  });

  it('adopts successor provisioning after a terminal pin when spawn is stopped', () => {
    expect(
      shouldAdoptSuccessorProvisioningRun({
        teamName: 'my-team',
        previousRunId: 'run-old',
        previousState: 'ready',
        nextRunId: 'run-new',
        ignoredRuntimeRunIds: {},
        pinnedSpawnStatuses: { alice: { status: 'offline', runtimeAlive: false } },
      })
    ).toBe(true);
  });

  it('adopts successor provisioning when runtime already retargeted', () => {
    expect(
      shouldAdoptSuccessorProvisioningRun({
        teamName: 'my-team',
        previousRunId: 'run-old',
        previousState: 'ready',
        nextRunId: 'run-new',
        currentRuntimeRunId: 'run-new',
        ignoredRuntimeRunIds: {},
        pinnedSpawnStatuses: { alice: { status: 'online', runtimeAlive: true } },
      })
    ).toBe(true);
  });

  it('does not steal an in-flight provisioning run', () => {
    expect(
      shouldAdoptSuccessorProvisioningRun({
        teamName: 'my-team',
        previousRunId: 'run-live',
        previousState: 'assembling',
        nextRunId: 'run-other',
        ignoredRuntimeRunIds: {},
        pinnedSpawnStatuses: { alice: { status: 'offline', runtimeAlive: false } },
      })
    ).toBe(false);
  });
});
