import {
  buildRestartDuplicateUnconfirmedReason,
  buildRestartGraceTimeoutReason,
  buildRestartStillRunningReason,
  createInitialMemberSpawnStatusEntry,
  deriveTaskActivityPauseAt,
  deriveTaskActivityResumeAt,
  MEMBER_LAUNCH_GRACE_MS,
  parseOptionalIsoMs,
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
  summarizeMemberSpawnStatusRecord,
} from '@main/services/team/provisioning/TeamProvisioningMemberSpawnStatusPolicy';
import { describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusEntry } from '@shared/types';

function makeStatus(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamProvisioningMemberSpawnStatusPolicy', () => {
  it('warns about unreadable audit config only after throttle and launch grace windows', () => {
    const acceptedAt = '2026-01-01T00:00:00.000Z';
    const nowMs = Date.parse(acceptedAt) + MEMBER_LAUNCH_GRACE_MS;
    const memberSpawnStatuses = new Map([
      ['Builder', { agentToolAccepted: true, firstSpawnAcceptedAt: acceptedAt }],
    ]);

    expect(
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs,
        lastWarnAt: nowMs - 9_999,
        expectedMembers: ['Builder'],
        memberSpawnStatuses,
      })
    ).toBe(false);
    expect(
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs,
        lastWarnAt: 0,
        expectedMembers: ['Builder'],
        memberSpawnStatuses,
      })
    ).toBe(true);
    expect(
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs,
        lastWarnAt: 0,
        expectedMembers: ['Reviewer'],
        memberSpawnStatuses,
      })
    ).toBe(false);
  });

  it('warns about missing registered members only after grace expiry and throttle', () => {
    expect(
      shouldWarnOnMissingRegisteredMember({
        nowMs: 20_000,
        lastWarnAt: 0,
        graceExpired: false,
      })
    ).toBe(false);
    expect(
      shouldWarnOnMissingRegisteredMember({
        nowMs: 20_000,
        lastWarnAt: 15_000,
        graceExpired: true,
      })
    ).toBe(false);
    expect(
      shouldWarnOnMissingRegisteredMember({
        nowMs: 20_000,
        lastWarnAt: 0,
        graceExpired: true,
      })
    ).toBe(true);
  });

  it('derives bounded task activity pause and resume timestamps', () => {
    expect(parseOptionalIsoMs(undefined)).toBe(0);
    expect(parseOptionalIsoMs('not-a-date')).toBe(0);
    expect(parseOptionalIsoMs('2026-01-01T00:00:00.000Z')).toBe(
      Date.parse('2026-01-01T00:00:00.000Z')
    );
    expect(
      deriveTaskActivityPauseAt(
        makeStatus({ lastHeartbeatAt: '2026-01-01T00:00:00.000Z' }),
        '2026-01-01T00:00:10.000Z'
      )
    ).toBe('2026-01-01T00:00:05.000Z');
    expect(
      deriveTaskActivityPauseAt(
        makeStatus({ lastHeartbeatAt: 'not-a-date' }),
        '2026-01-01T00:00:10.000Z'
      )
    ).toBe('2026-01-01T00:00:05.000Z');
    expect(
      deriveTaskActivityPauseAt(
        makeStatus({ updatedAt: 'not-a-date' }),
        '2026-01-01T00:00:10.000Z'
      )
    ).toBe('2026-01-01T00:00:10.000Z');
    expect(
      deriveTaskActivityResumeAt(
        makeStatus({ updatedAt: '2026-01-01T00:00:05.000Z' }),
        '2026-01-01T00:00:06.000Z',
        '2026-01-01T00:00:10.000Z'
      )
    ).toBe('2026-01-01T00:00:06.000Z');
    expect(
      deriveTaskActivityResumeAt(
        makeStatus({ updatedAt: '2026-01-01T00:00:05.000Z' }),
        '2026-01-01T00:00:04.000Z',
        '2026-01-01T00:00:10.000Z'
      )
    ).toBe('2026-01-01T00:00:10.000Z');
  });

  it('creates initial member spawn statuses with the current timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      expect(createInitialMemberSpawnStatusEntry()).toEqual({
        status: 'offline',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        updatedAt: '2026-01-02T03:04:05.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarizes member spawn statuses across launch states and liveness kinds', () => {
    expect(
      summarizeMemberSpawnStatusRecord(['Confirmed', 'Missing'], {
        Confirmed: makeStatus({ launchState: 'confirmed_alive' }),
        Skipped: makeStatus({ launchState: 'skipped_for_launch' }),
        Failed: makeStatus({ launchState: 'failed_to_start' }),
        Permission: makeStatus({
          launchState: 'runtime_pending_permission',
          runtimeAlive: true,
        }),
        Shell: makeStatus({ livenessKind: 'shell_only' }),
        Runtime: makeStatus({ livenessKind: 'runtime_process' }),
        Candidate: makeStatus({ livenessKind: 'runtime_process_candidate' }),
        MissingRuntime: makeStatus({ livenessKind: 'registered_only' }),
      })
    ).toEqual({
      confirmedCount: 1,
      pendingCount: 6,
      failedCount: 1,
      skippedCount: 1,
      runtimeAlivePendingCount: 1,
      shellOnlyPendingCount: 1,
      runtimeProcessPendingCount: 1,
      runtimeCandidatePendingCount: 1,
      noRuntimePendingCount: 1,
      permissionPendingCount: 1,
    });
  });

  it('builds restart status reasons without changing message text', () => {
    expect(buildRestartStillRunningReason('Builder')).toContain(
      'previous runtime still appears to be active'
    );
    expect(buildRestartDuplicateUnconfirmedReason('Builder')).toContain(
      'duplicate_skipped without a reason'
    );
    expect(buildRestartDuplicateUnconfirmedReason('Builder', 'still running')).toContain(
      'unrecognized reason "still running"'
    );
    expect(buildRestartGraceTimeoutReason('Builder')).toBe(
      'Teammate "Builder" did not rejoin within the restart grace window.'
    );
  });
});
