import { describe, expect, it } from 'vitest';

import {
  buildTeamScopedProgressTombstones,
  collectTeamScopedStateRemovals,
  collectTeamScopedVisibleLoadingResets,
} from '../../../src/renderer/store/team/teamScopedStateCleanup';

const teamScopedRecordKeys = [
  'teamDataCacheByName',
  'teamAgentRuntimeByTeam',
  'teamMessagesByName',
  'memberActivityMetaByTeam',
  'provisioningSnapshotByTeam',
  'currentProvisioningRunIdByTeam',
  'currentRuntimeRunIdByTeam',
  'provisioningStartedAtFloorByTeam',
  'leadActivityByTeam',
  'leadContextByTeam',
  'activeTaskLogActivityByTeam',
  'activeToolsByTeam',
  'finishedVisibleByTeam',
  'toolHistoryByTeam',
  'memberSpawnStatusesByTeam',
  'memberSpawnSnapshotsByTeam',
  'provisioningErrorByTeam',
] as const;

function buildRecord(label: string): Record<string, unknown> {
  return {
    'my-team': `${label}:mine`,
    'other-team': `${label}:other`,
  };
}

function buildRemovalState(): Parameters<typeof collectTeamScopedStateRemovals>[0] {
  return {
    provisioningRuns: {
      'run-mine-1': { teamName: 'my-team' },
      'run-other': { teamName: 'other-team' },
      'run-mine-2': { teamName: 'my-team' },
    },
    teamDataCacheByName: buildRecord('teamDataCacheByName'),
    teamAgentRuntimeByTeam: buildRecord('teamAgentRuntimeByTeam'),
    teamMessagesByName: buildRecord('teamMessagesByName'),
    memberActivityMetaByTeam: buildRecord('memberActivityMetaByTeam'),
    provisioningSnapshotByTeam: buildRecord('provisioningSnapshotByTeam'),
    currentProvisioningRunIdByTeam: buildRecord('currentProvisioningRunIdByTeam'),
    currentRuntimeRunIdByTeam: buildRecord('currentRuntimeRunIdByTeam'),
    provisioningStartedAtFloorByTeam: buildRecord('provisioningStartedAtFloorByTeam'),
    leadActivityByTeam: buildRecord('leadActivityByTeam'),
    leadContextByTeam: buildRecord('leadContextByTeam'),
    activeTaskLogActivityByTeam: buildRecord('activeTaskLogActivityByTeam'),
    activeToolsByTeam: buildRecord('activeToolsByTeam'),
    finishedVisibleByTeam: buildRecord('finishedVisibleByTeam'),
    toolHistoryByTeam: buildRecord('toolHistoryByTeam'),
    memberSpawnStatusesByTeam: buildRecord('memberSpawnStatusesByTeam'),
    memberSpawnSnapshotsByTeam: buildRecord('memberSpawnSnapshotsByTeam'),
    provisioningErrorByTeam: buildRecord('provisioningErrorByTeam'),
  };
}

describe('teamScopedStateCleanup', () => {
  it('resets visible team loading and message loading flags for the scoped team', () => {
    const otherEntry = {
      loadingHead: true,
      loadingOlder: false,
      marker: 'other',
    };
    const patch = collectTeamScopedVisibleLoadingResets(
      {
        teamMessagesByName: {
          'my-team': {
            loadingHead: true,
            loadingOlder: true,
            marker: 'mine',
          },
          'other-team': otherEntry,
        },
        selectedTeamName: 'my-team',
        selectedTeamLoading: true,
        selectedTeamError: 'Boom',
      },
      'my-team'
    );

    expect(patch).toEqual({
      teamMessagesByName: {
        'my-team': {
          loadingHead: false,
          loadingOlder: false,
          marker: 'mine',
        },
        'other-team': otherEntry,
      },
      selectedTeamLoading: false,
      selectedTeamError: null,
    });
  });

  it('does not emit visible loading changes when the scoped team is already idle', () => {
    const patch = collectTeamScopedVisibleLoadingResets(
      {
        teamMessagesByName: {
          'my-team': {
            loadingHead: false,
            loadingOlder: false,
          },
        },
        selectedTeamName: 'other-team',
        selectedTeamLoading: false,
        selectedTeamError: null,
      },
      'my-team'
    );

    expect(patch).toEqual({});
  });

  it('removes scoped team records and provisioning runs while preserving other teams', () => {
    const patch = collectTeamScopedStateRemovals(buildRemovalState(), 'my-team');

    expect(patch.provisioningRuns).toEqual({
      'run-other': { teamName: 'other-team' },
    });
    for (const key of teamScopedRecordKeys) {
      expect(patch[key]).toEqual({
        'other-team': `${key}:other`,
      });
    }
  });

  it('does not emit removal changes when the team is absent', () => {
    const state = buildRemovalState();
    const patch = collectTeamScopedStateRemovals(state, 'missing-team');

    expect(patch).toEqual({});
  });

  it('tombstones current provisioning and runtime run ids for the scoped team', () => {
    const tombstones = buildTeamScopedProgressTombstones(
      {
        currentProvisioningRunIdByTeam: {
          'my-team': 'provisioning-run-1',
          'other-team': 'provisioning-run-2',
        },
        currentRuntimeRunIdByTeam: {
          'my-team': 'runtime-run-1',
        },
        ignoredProvisioningRunIds: {
          old: 'old-team',
        },
        ignoredRuntimeRunIds: {
          'old-runtime': 'old-team',
        },
        provisioningStartedAtFloorByTeam: {
          'other-team': '2026-01-01T00:00:00.000Z',
        },
      },
      'my-team',
      '2026-05-22T10:00:00.000Z'
    );

    expect(tombstones).toEqual({
      ignoredProvisioningRunIds: {
        old: 'old-team',
        'provisioning-run-1': 'my-team',
      },
      ignoredRuntimeRunIds: {
        'old-runtime': 'old-team',
        'runtime-run-1': 'my-team',
      },
      provisioningStartedAtFloorByTeam: {
        'other-team': '2026-01-01T00:00:00.000Z',
        'my-team': '2026-05-22T10:00:00.000Z',
      },
    });
  });

  it('still records a floor when there are no current run ids to tombstone', () => {
    const tombstones = buildTeamScopedProgressTombstones(
      {
        currentProvisioningRunIdByTeam: {},
        currentRuntimeRunIdByTeam: {
          'my-team': null,
        },
        ignoredProvisioningRunIds: {},
        ignoredRuntimeRunIds: {},
        provisioningStartedAtFloorByTeam: {},
      },
      'my-team',
      '2026-05-22T10:00:00.000Z'
    );

    expect(tombstones).toEqual({
      ignoredProvisioningRunIds: {},
      ignoredRuntimeRunIds: {},
      provisioningStartedAtFloorByTeam: {
        'my-team': '2026-05-22T10:00:00.000Z',
      },
    });
  });
});
