import { describe, expect, it } from 'vitest';

import {
  buildTeamCreateLaunchAnalyticsContext,
  buildTeamLaunchAnalyticsContext,
  getTeamLaunchAnalyticsStep,
  getTeamLaunchAnalyticsTimestampMs,
} from '../../../../../src/features/team-provisioning/core/domain/teamLaunchAnalyticsPolicy';

import type { TeamCreateRequest, TeamLaunchRequest, TeamViewSnapshot } from '@shared/types';

function snapshot(providerIds: Array<'anthropic' | 'codex'>): TeamViewSnapshot {
  return {
    teamName: 'sandbox-team',
    config: { name: 'Sandbox Team' },
    tasks: [],
    members: providerIds.map((providerId, index) => ({
      name: `member-${index}`,
      currentTaskId: null,
      taskCount: 0,
      providerId,
    })),
    kanbanState: { teamName: 'sandbox-team', reviewers: [], tasks: {} },
    processes: [],
  };
}

describe('teamLaunchAnalyticsPolicy', () => {
  it('inherits the create provider only for members without an override', () => {
    const request = {
      teamName: 'sandbox-team',
      cwd: '/tmp/sandbox-project',
      providerId: 'codex',
      members: [{ name: 'alice' }, { name: 'bob', providerId: 'anthropic' }],
    } satisfies TeamCreateRequest;

    expect(buildTeamCreateLaunchAnalyticsContext(request, 123)).toEqual({
      startedAtMs: 123,
      memberCount: 2,
      providerIds: ['codex', 'anthropic'],
    });
  });

  it('prefers snapshot providers and falls back to the launch provider without team data', () => {
    const request = {
      teamName: 'sandbox-team',
      cwd: '/tmp/sandbox-project',
      providerId: 'codex',
    } satisfies TeamLaunchRequest;

    expect(buildTeamLaunchAnalyticsContext(request, snapshot(['anthropic']), 456)).toEqual({
      startedAtMs: 456,
      memberCount: 1,
      providerIds: ['anthropic'],
    });
    expect(buildTeamLaunchAnalyticsContext(request, null, 456)).toEqual({
      startedAtMs: 456,
      memberCount: null,
      providerIds: ['codex'],
    });
  });

  it.each([
    ['validating', 'config_validation'],
    ['spawning', 'runtime_prepare'],
    ['configuring', 'member_spawn'],
    ['assembling', 'member_spawn'],
    ['finalizing', 'bootstrap'],
    ['verifying', 'ready_check'],
    ['ready', 'ready_check'],
  ] as const)('maps %s progress to the %s analytics step', (state, expected) => {
    expect(getTeamLaunchAnalyticsStep(state)).toBe(expected);
  });

  it('rejects invalid timestamps without manufacturing freshness', () => {
    expect(getTeamLaunchAnalyticsTimestampMs(undefined)).toBeNull();
    expect(getTeamLaunchAnalyticsTimestampMs('not-a-date')).toBeNull();
    expect(getTeamLaunchAnalyticsTimestampMs('2026-07-24T10:00:00.000Z')).toBe(
      Date.parse('2026-07-24T10:00:00.000Z')
    );
  });
});
