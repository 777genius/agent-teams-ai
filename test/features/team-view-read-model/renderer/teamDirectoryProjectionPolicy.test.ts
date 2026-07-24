import { describe, expect, it } from 'vitest';

import {
  buildGlobalTaskProjectionNotification,
  buildTeamSummaryIndexes,
  removeProvisioningSnapshotsForTeams,
} from '../../../../src/features/team-view-read-model/renderer';

import type { TeamSummary } from '../../../../src/shared/types';

function team(teamName: string, input: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    projectPath: `/projects/${teamName}`,
    ...input,
  } as TeamSummary;
}

describe('team directory projection policy', () => {
  it('indexes canonical names plus lead and historical sessions', () => {
    const alpha = team('alpha', {
      leadSessionId: 'lead-alpha',
      sessionHistory: ['old-alpha', '', 'lead-alpha'],
    });
    const beta = team('beta');

    const indexes = buildTeamSummaryIndexes([alpha, beta]);

    expect(indexes.teamByName).toEqual({ alpha, beta });
    expect(indexes.teamBySessionId).toEqual({
      'lead-alpha': alpha,
      'old-alpha': alpha,
    });
  });

  it('preserves snapshot identity when no listed team resolves a provisional card', () => {
    const snapshots = { draft: team('draft') };

    expect(removeProvisioningSnapshotsForTeams(snapshots, [team('alpha')])).toBe(snapshots);
  });

  it('clones once and removes only snapshots resolved by the directory', () => {
    const draft = team('draft');
    const alpha = team('alpha');
    const snapshots = { alpha, draft };

    const result = removeProvisioningSnapshotsForTeams(snapshots, [team('alpha'), team('other')]);

    expect(result).not.toBe(snapshots);
    expect(result).toEqual({ draft });
    expect(snapshots).toEqual({ alpha, draft });
  });

  it('builds notifications only after initialization and only for a new task array', () => {
    const oldTasks = [] as never[];
    const nextTasks = [] as never[];
    const state = {
      appConfig: null,
      globalTasks: oldTasks,
      globalTasksInitialized: true,
      teamByName: {},
    };

    expect(buildGlobalTaskProjectionNotification(state, oldTasks)).toBeNull();
    expect(
      buildGlobalTaskProjectionNotification({ ...state, globalTasksInitialized: false }, nextTasks)
    ).toBeNull();
    expect(buildGlobalTaskProjectionNotification(state, nextTasks)).toEqual({
      oldTasks,
      newTasks: nextTasks,
      appConfig: null,
      teamByName: {},
      isInitialFetch: false,
    });
  });
});
