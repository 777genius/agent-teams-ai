import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';
import { describe, expect, it } from 'vitest';

import type { TeamProvisioningProgress, TeamSummary } from '@shared/types';

function team(patch: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName: 'atlas-hq-10',
    displayName: 'atlas-hq-10',
    description: '',
    color: 'blue',
    memberCount: 4,
    members: [],
    taskCount: 0,
    lastActivity: null,
    ...patch,
  } as TeamSummary;
}

function progress(
  state: TeamProvisioningProgress['state'],
  updatedAt: string
): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'atlas-hq-10',
    state,
    message: state,
    startedAt: updatedAt,
    updatedAt,
  };
}

describe('team list status', () => {
  const nowMs = Date.parse('2026-04-28T20:00:00.000Z');

  it('treats active provisioning as launching even if the previous lead state was offline', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        [],
        progress('assembling', '2026-04-28T19:59:59.000Z'),
        { 'atlas-hq-10': 'offline' },
        nowMs
      )
    ).toBe('provisioning');
  });

  it('keeps a recent ready launch running until aliveList catches up', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        [],
        progress('ready', '2026-04-28T19:59:45.000Z'),
        {},
        nowMs
      )
    ).toBe('idle');
  });

  it('does not let optimistic ready override an explicit offline lead event', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        [],
        progress('ready', '2026-04-28T19:59:45.000Z'),
        { 'atlas-hq-10': 'offline' },
        nowMs
      )
    ).toBe('offline');
  });

  it('does not let stale aliveList data override an explicit offline lead event', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        ['atlas-hq-10'],
        null,
        { 'atlas-hq-10': 'offline' },
        nowMs
      )
    ).toBe('offline');
  });

  it('does not let stale aliveList data override stopped runtime progress', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        ['atlas-hq-10'],
        progress('disconnected', '2026-04-28T19:59:45.000Z'),
        {},
        nowMs
      )
    ).toBe('offline');
  });

  it('expires optimistic ready state if aliveList still does not report the team alive', () => {
    expect(
      resolveTeamStatus(
        team(),
        'atlas-hq-10',
        [],
        progress('ready', '2026-04-28T19:58:00.000Z'),
        {},
        nowMs
      )
    ).toBe('offline');
  });

  it('does not mask partial launch failures as optimistic running', () => {
    expect(
      resolveTeamStatus(
        team({ partialLaunchFailure: true, teamLaunchState: 'partial_failure' }),
        'atlas-hq-10',
        [],
        progress('ready', '2026-04-28T19:59:45.000Z'),
        {},
        nowMs
      )
    ).toBe('partial_failure');
  });

  it('classifies running filter state consistently', () => {
    expect(isTeamListStatusRunning('idle')).toBe(true);
    expect(isTeamListStatusRunning('provisioning')).toBe(true);
    expect(isTeamListStatusRunning('offline')).toBe(false);
    expect(isTeamListStatusRunning('partial_failure')).toBe(false);
    expect(isTeamListStatusRunning('partial_pending')).toBe(false);
  });
});
