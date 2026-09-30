import { describe, expect, it } from 'vitest';

import { buildDesktopTeamDirectoryView } from '../../../../src/renderer/components/team/desktopTeamDirectoryRows';

import type { TeamSummary } from '@shared/types';

function team(teamName: string, lastActivity: string | null = null): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity,
  };
}

function view(aliveReadKnown: boolean) {
  return buildDesktopTeamDirectoryView({
    teams: [team('offline', '2026-09-27T00:00:00.000Z'), team('running')],
    scopeKey: 'local',
    aliveTeams: ['running'],
    aliveReadKnown,
    provisioningState: { currentProvisioningRunIdByTeam: {}, provisioningRuns: {} },
    leadActivityByTeam: {},
    currentProjectPath: null,
    filter: { query: '', selectedStatuses: new Set<'running' | 'offline'>(['offline']) },
    nowMs: Date.parse('2026-09-28T00:00:00.000Z'),
  });
}

describe('Desktop directory adapter', () => {
  it('does not call an unverified alive-list read offline, then filters the confirmed result', () => {
    expect(view(false).teams).toEqual([]);
    expect(view(false).rows.map((row) => row.runtime)).toEqual(['unknown', 'unknown']);
    expect(view(true).teams.map((item) => item.teamName)).toEqual(['offline']);
  });
});
