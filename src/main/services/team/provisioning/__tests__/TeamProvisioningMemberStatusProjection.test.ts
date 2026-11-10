import { describe, expect, it } from 'vitest';

import {
  buildRuntimeSpawnStatusRecord,
  getFailedSpawnMembersFromStatuses,
  projectPendingRestartStatusForSnapshot,
  shouldPreferCurrentLaunchMemberStatus,
} from '../TeamProvisioningMemberStatusProjection';

import type { MemberSpawnStatusEntry } from '@shared/types';

const baseStatus = (overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'offline',
  launchState: 'starting',
  agentToolAccepted: false,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('member status projection helpers', () => {
  it('returns failed spawn members sorted by name', () => {
    const statuses = new Map<string, MemberSpawnStatusEntry>([
      ['zeta', baseStatus({ launchState: 'failed_to_start', error: 'terminal error' })],
      ['alpha', baseStatus({ launchState: 'failed_to_start', hardFailureReason: 'hard fail' })],
      ['beta', baseStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: true })],
    ]);

    expect(getFailedSpawnMembersFromStatuses(statuses)).toEqual([
      {
        name: 'alpha',
        error: 'hard fail',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'zeta',
        error: 'terminal error',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('projects pending restarts as waiting for bootstrap', () => {
    const projected = projectPendingRestartStatusForSnapshot(
      'worker',
      baseStatus(),
      new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]]),
      Date.parse('2026-01-01T00:01:30.000Z')
    );

    expect(projected).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      firstSpawnAcceptedAt: '2026-01-01T00:01:00.000Z',
      runtimeDiagnostic: 'Manual restart is already in progress; waiting for teammate bootstrap.',
      runtimeDiagnosticSeverity: 'info',
    });
  });

  it('projects a pending restart as failed once the settle window elapses', () => {
    const projected = projectPendingRestartStatusForSnapshot(
      'worker',
      baseStatus(),
      new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]]),
      Date.parse('2026-01-01T00:01:00.000Z') + 181_000
    );

    expect(projected).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      bootstrapConfirmed: false,
      runtimeAlive: false,
      hardFailureReason: 'Restart did not confirm teammate bootstrap within the expected window.',
      runtimeDiagnosticSeverity: 'error',
    });
  });

  it('does not alter terminal launch states for pending restarts', () => {
    const current = baseStatus({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });

    expect(
      projectPendingRestartStatusForSnapshot(
        'worker',
        current,
        new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]])
      )
    ).toBe(current);
  });

  it('builds status records for expected members and applies restart projection', () => {
    const statuses = buildRuntimeSpawnStatusRecord(
      {
        expectedMembers: ['lead', 'worker'],
        memberSpawnStatuses: new Map([['lead', baseStatus({ launchState: 'confirmed_alive' })]]),
        pendingMemberRestarts: new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]]),
      },
      Date.parse('2026-01-01T00:01:30.000Z')
    );

    expect(statuses.lead).toMatchObject({ launchState: 'confirmed_alive' });
    expect(statuses.worker).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      firstSpawnAcceptedAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('prefers current launch member status only when tracked status is non-terminal', () => {
    const confirmedLaunch = baseStatus({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });

    expect(shouldPreferCurrentLaunchMemberStatus(undefined, confirmedLaunch)).toBe(true);
    expect(shouldPreferCurrentLaunchMemberStatus(baseStatus(), confirmedLaunch)).toBe(true);
    expect(
      shouldPreferCurrentLaunchMemberStatus(
        baseStatus({ launchState: 'failed_to_start' }),
        confirmedLaunch
      )
    ).toBe(false);
    expect(
      shouldPreferCurrentLaunchMemberStatus(
        baseStatus({ launchState: 'runtime_pending_permission' }),
        confirmedLaunch
      )
    ).toBe(false);
    expect(
      shouldPreferCurrentLaunchMemberStatus(baseStatus({ hardFailure: true }), confirmedLaunch)
    ).toBe(false);
    expect(
      shouldPreferCurrentLaunchMemberStatus(
        baseStatus(),
        baseStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: false })
      )
    ).toBe(true);
    expect(
      shouldPreferCurrentLaunchMemberStatus(
        baseStatus(),
        baseStatus({ launchState: 'starting', bootstrapConfirmed: false })
      )
    ).toBe(false);
  });
});
