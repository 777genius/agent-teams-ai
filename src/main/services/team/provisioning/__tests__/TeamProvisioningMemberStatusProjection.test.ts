import { describe, expect, it } from 'vitest';

import {
  buildRuntimeSpawnStatusRecord,
  getFailedSpawnMembersFromStatuses,
  projectPendingRestartStatusForSnapshot,
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
      new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]])
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
    const statuses = buildRuntimeSpawnStatusRecord({
      expectedMembers: ['lead', 'worker'],
      memberSpawnStatuses: new Map([['lead', baseStatus({ launchState: 'confirmed_alive' })]]),
      pendingMemberRestarts: new Map([['worker', { requestedAt: '2026-01-01T00:01:00.000Z' }]]),
    });

    expect(statuses.lead).toMatchObject({ launchState: 'confirmed_alive' });
    expect(statuses.worker).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      firstSpawnAcceptedAt: '2026-01-01T00:01:00.000Z',
    });
  });
});
