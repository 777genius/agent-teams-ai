import { hostTeamRunId, hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { describe, expect, it } from 'vitest';

import {
  isPinnedRuntimeRunFullyStopped,
  resolveIncomingRuntimeRunAdoption,
  retainTerminalMemberSpawnStatuses,
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

  it('requires the current Host runtime pin for a live roster revision', () => {
    const teamName = hostTeamSelectionKey('TEST-owner');
    const previousRunId = hostTeamRunId('TEST-owner', 'TEST-launch', 'original');
    const nextRunId = hostTeamRunId('TEST-owner', 'TEST-launch', 'restored');
    const input = {
      teamName, previousRunId, nextRunId, previousState: 'ready' as const,
      currentRuntimeRunId: previousRunId,
      ignoredRuntimeRunIds: {},
      pinnedSpawnStatuses: { bob: { status: 'online' as const, runtimeAlive: true } },
    };
    expect(shouldAdoptSuccessorProvisioningRun(input)).toBe(false);
    expect(shouldAdoptSuccessorProvisioningRun({
      ...input, currentRuntimeRunId: hostTeamRunId('TEST-owner', 'TEST-launch', 'added'),
    })).toBe(false);
    expect(shouldAdoptSuccessorProvisioningRun({
      ...input, currentRuntimeRunId: nextRunId,
    })).toBe(true);
    expect(shouldAdoptSuccessorProvisioningRun({
      ...input, currentRuntimeRunId: nextRunId, previousState: 'assembling',
    })).toBe(true);
    for (const overrides of [
      { teamName: hostTeamSelectionKey('TEST-foreign') },
      { teamName: 'legacy-team' },
      { nextRunId: hostTeamRunId('TEST-foreign', 'TEST-launch', 'restored') },
      { nextRunId: hostTeamRunId('TEST-owner', 'TEST-other-launch', 'restored') },
      { nextRunId: 'host-run:invalid' },
      { currentRuntimeRunId: hostTeamRunId('TEST-owner', 'TEST-other-launch', 'current') },
      { currentRuntimeRunId: null },
      { ignoredRuntimeRunIds: { [nextRunId]: teamName } },
      { previousState: 'assembling' as const },
    ]) {
      expect(shouldAdoptSuccessorProvisioningRun({ ...input, ...overrides })).toBe(false);
    }
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

describe('retained same-run live status after terminal primary failure', () => {
  it.each(['failed', 'cancelled', 'disconnected'] as const)(
    'retains live truth only for failed current run: %s',
    (state) => {
      const statuses = {
        alice: {
          status: 'error' as const,
          launchState: 'failed_to_start' as const,
          updatedAt: '',
          runtimeAlive: false,
        },
        bob: {
          status: 'online' as const,
          launchState: 'confirmed_alive' as const,
          updatedAt: '',
          runtimeAlive: true,
        },
      };
      const progress = {
        state,
        teamName: 'team',
        runId: 'run',
        retainedSecondaryRuntime: true as const,
        message: '',
        startedAt: '',
        updatedAt: '',
      };
      expect(Object.keys(retainTerminalMemberSpawnStatuses(statuses, progress, 'run'))).toEqual(
        state === 'failed' ? ['alice', 'bob'] : ['alice']
      );
      expect(
        Object.keys(retainTerminalMemberSpawnStatuses(statuses, progress, 'other-run'))
      ).toEqual(['alice']);
      expect(
        Object.keys(
          retainTerminalMemberSpawnStatuses(
            statuses,
            { ...progress, retainedSecondaryRuntime: undefined },
            'run'
          )
        )
      ).toEqual(['alice']);
    }
  );
});
