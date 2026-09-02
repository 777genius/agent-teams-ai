import { describe, expect, it } from 'vitest';

import {
  applyExpiredLaunchGraceToPersistedStatuses,
  hasExpiredMemberLaunchGrace,
  MEMBER_LAUNCH_GRACE_TIMEOUT_REASON,
} from '../TeamProvisioningMemberSpawnStatusPolicy';

import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW_MS = Date.parse('2026-08-27T18:10:00.000Z');
const ACCEPTED_BEFORE_GRACE = new Date(NOW_MS - 10 * 60_000).toISOString();
const ACCEPTED_WITHIN_GRACE = new Date(NOW_MS - 30_000).toISOString();

function entry(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    firstSpawnAcceptedAt: ACCEPTED_BEFORE_GRACE,
    updatedAt: '2026-08-27T18:08:00.000Z',
    ...overrides,
  };
}

describe('hasExpiredMemberLaunchGrace', () => {
  it('holds for an accepted member with no runtime once the grace window elapsed', () => {
    expect(hasExpiredMemberLaunchGrace(entry(), { nowMs: NOW_MS })).toBe(true);
  });

  it('honours an explicit grace window', () => {
    expect(
      hasExpiredMemberLaunchGrace(entry({ firstSpawnAcceptedAt: ACCEPTED_WITHIN_GRACE }), {
        nowMs: NOW_MS,
        graceMs: 10_000,
      })
    ).toBe(true);
  });

  // The predicate reads liveness, so it is only meaningful once live runtime
  // metadata has been applied. Running it against a persisted `runtimeAlive`
  // that a later liveness pass disproves is the defect this rule exists for.
  it('does not hold while the entry still claims a live runtime', () => {
    expect(hasExpiredMemberLaunchGrace(entry({ runtimeAlive: true }), { nowMs: NOW_MS })).toBe(
      false
    );
  });

  it.each([
    ['the member is still inside the window', { firstSpawnAcceptedAt: ACCEPTED_WITHIN_GRACE }],
    ['the spawn was never accepted', { agentToolAccepted: false }],
    ['there is no accepted timestamp at all', { firstSpawnAcceptedAt: undefined }],
    ['the accepted timestamp is unparseable', { firstSpawnAcceptedAt: 'not-a-date' }],
    ['bootstrap already confirmed', { bootstrapConfirmed: true }],
    ['bootstrap is reported as stalled', { bootstrapStalled: true }],
    ['a hard failure was already recorded', { hardFailure: true }],
    ['the launch state is confirmed_alive', { launchState: 'confirmed_alive' as const }],
    ['the launch state is failed_to_start', { launchState: 'failed_to_start' as const }],
    ['the member was skipped for launch', { launchState: 'skipped_for_launch' as const }],
  ])('does not hold when %s', (_case, overrides) => {
    expect(hasExpiredMemberLaunchGrace(entry(overrides), { nowMs: NOW_MS })).toBe(false);
  });
});

describe('applyExpiredLaunchGraceToPersistedStatuses', () => {
  it('turns an expired member into a hard failure with the grace reason', () => {
    const statuses: Record<string, MemberSpawnStatusEntry> = {
      Worker: entry({ livenessSource: 'process' }),
    };

    applyExpiredLaunchGraceToPersistedStatuses(statuses, NOW_MS);

    expect(statuses.Worker).toMatchObject({
      status: 'error',
      hardFailure: true,
      hardFailureReason: MEMBER_LAUNCH_GRACE_TIMEOUT_REASON,
      launchState: 'failed_to_start',
      runtimeAlive: false,
    });
    expect(statuses.Worker?.livenessSource).toBeUndefined();
  });

  it('keeps a failure reason that was already recorded', () => {
    const statuses: Record<string, MemberSpawnStatusEntry> = {
      Worker: entry({ hardFailureReason: 'Teammate was never spawned during launch.' }),
    };

    applyExpiredLaunchGraceToPersistedStatuses(statuses, NOW_MS);

    expect(statuses.Worker?.hardFailureReason).toBe('Teammate was never spawned during launch.');
  });

  // Negative control: without this the projection would rewrite every member on
  // every read, and a live teammate would be reported as failed.
  it('leaves members that have not expired exactly as they were', () => {
    const live = entry({ runtimeAlive: true, status: 'online' });
    const young = entry({ firstSpawnAcceptedAt: ACCEPTED_WITHIN_GRACE });
    const statuses: Record<string, MemberSpawnStatusEntry> = { Worker: live, Scout: young };

    applyExpiredLaunchGraceToPersistedStatuses(statuses, NOW_MS);

    expect(statuses.Worker).toBe(live);
    expect(statuses.Scout).toBe(young);
  });

  it('recomputes the same verdict on a second pass instead of accumulating', () => {
    const statuses: Record<string, MemberSpawnStatusEntry> = { Worker: entry() };

    applyExpiredLaunchGraceToPersistedStatuses(statuses, NOW_MS);
    const afterFirstPass = statuses.Worker;
    applyExpiredLaunchGraceToPersistedStatuses(statuses, NOW_MS + 60_000);

    expect(statuses.Worker).toBe(afterFirstPass);
  });
});
