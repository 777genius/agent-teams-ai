import { describe, expect, it } from 'vitest';

import {
  areExpectedMembersEqual,
  areLaunchSummaryCountsEqual,
  areMemberSpawnSnapshotsSemanticallyEqual,
  areMemberSpawnStatusEntriesEqual,
  areMemberSpawnStatusesEqual,
} from '../../../src/renderer/store/team/teamMemberSpawnSnapshotEquality';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSummary,
} from '../../../src/shared/types';

function createSummary(
  overrides: Partial<PersistedTeamLaunchSummary> = {}
): PersistedTeamLaunchSummary {
  return {
    confirmedCount: 1,
    pendingCount: 0,
    failedCount: 0,
    skippedCount: 0,
    runtimeAlivePendingCount: 0,
    shellOnlyPendingCount: 0,
    runtimeProcessPendingCount: 0,
    runtimeCandidatePendingCount: 0,
    noRuntimePendingCount: 0,
    permissionPendingCount: 0,
    ...overrides,
  };
}

function createStatusEntry(
  overrides: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    updatedAt: '2026-05-22T10:00:00.000Z',
    livenessSource: 'heartbeat',
    runtimeAlive: true,
    runtimeModel: 'gpt-5.3-codex',
    livenessKind: 'confirmed_bootstrap',
    runtimeDiagnostic: 'Ready',
    runtimeDiagnosticSeverity: 'info',
    bootstrapConfirmed: true,
    hardFailure: false,
    pendingPermissionRequestIds: ['perm-a', 'perm-b'],
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<MemberSpawnStatusesSnapshot> = {}
): MemberSpawnStatusesSnapshot {
  return {
    statuses: {
      alice: createStatusEntry(),
    },
    runId: 'run-1',
    teamLaunchState: 'clean_success',
    launchPhase: 'active',
    expectedMembers: ['alice'],
    updatedAt: '2026-05-22T10:00:00.000Z',
    summary: createSummary(),
    source: 'live',
    ...overrides,
  };
}

describe('teamMemberSpawnSnapshotEquality', () => {
  it('compares launch summaries by visible counts', () => {
    expect(areLaunchSummaryCountsEqual(createSummary(), createSummary())).toBe(true);
    expect(
      areLaunchSummaryCountsEqual(createSummary(), createSummary({ permissionPendingCount: 1 }))
    ).toBe(false);
    expect(areLaunchSummaryCountsEqual(undefined, undefined)).toBe(true);
    expect(areLaunchSummaryCountsEqual(undefined, createSummary())).toBe(false);
  });

  it('compares expected members in stable order', () => {
    expect(areExpectedMembersEqual(['alice', 'bob'], ['alice', 'bob'])).toBe(true);
    expect(areExpectedMembersEqual(['alice', 'bob'], ['bob', 'alice'])).toBe(false);
    expect(areExpectedMembersEqual(undefined, undefined)).toBe(true);
    expect(areExpectedMembersEqual(undefined, [])).toBe(false);
  });

  it('ignores non-visible status churn and unordered pending permission ids', () => {
    const left = createStatusEntry({
      pendingPermissionRequestIds: ['perm-b', 'perm-a'],
      updatedAt: '2026-05-22T10:00:00.000Z',
      agentToolAccepted: true,
      firstSpawnAcceptedAt: '2026-05-22T10:00:01.000Z',
      lastHeartbeatAt: '2026-05-22T10:00:02.000Z',
      livenessLastCheckedAt: '2026-05-22T10:00:03.000Z',
      bootstrapStalled: true,
    });
    const right = createStatusEntry({
      pendingPermissionRequestIds: ['perm-a', 'perm-b'],
      updatedAt: '2026-05-22T10:05:00.000Z',
      agentToolAccepted: false,
      firstSpawnAcceptedAt: '2026-05-22T10:05:01.000Z',
      lastHeartbeatAt: '2026-05-22T10:05:02.000Z',
      livenessLastCheckedAt: '2026-05-22T10:05:03.000Z',
      bootstrapStalled: false,
    });

    expect(areMemberSpawnStatusEntriesEqual(left, right)).toBe(true);
  });

  it('detects visible status entry changes', () => {
    expect(
      areMemberSpawnStatusEntriesEqual(
        createStatusEntry(),
        createStatusEntry({ runtimeDiagnosticSeverity: 'warning' })
      )
    ).toBe(false);
    expect(
      areMemberSpawnStatusEntriesEqual(
        createStatusEntry(),
        createStatusEntry({ pendingPermissionRequestIds: ['perm-a'] })
      )
    ).toBe(false);
  });

  it('compares per-member status maps by keys and semantic entries', () => {
    expect(
      areMemberSpawnStatusesEqual(
        {
          alice: createStatusEntry(),
          bob: createStatusEntry({ runtimeModel: 'gpt-5.4' }),
        },
        {
          bob: createStatusEntry({ runtimeModel: 'gpt-5.4' }),
          alice: createStatusEntry(),
        }
      )
    ).toBe(true);
    expect(
      areMemberSpawnStatusesEqual(
        {
          alice: createStatusEntry(),
        },
        {
          alice: createStatusEntry(),
          bob: createStatusEntry(),
        }
      )
    ).toBe(false);
  });

  it('compares snapshots by semantic launch fields and ignores snapshot updatedAt churn', () => {
    const left = createSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
    });
    const right = createSnapshot({
      updatedAt: '2026-05-22T10:05:00.000Z',
      statuses: {
        alice: createStatusEntry({
          pendingPermissionRequestIds: ['perm-b', 'perm-a'],
          updatedAt: '2026-05-22T10:05:00.000Z',
        }),
      },
    });

    expect(areMemberSpawnSnapshotsSemanticallyEqual(left, right)).toBe(true);
  });

  it('detects semantic snapshot changes', () => {
    expect(
      areMemberSpawnSnapshotsSemanticallyEqual(
        createSnapshot(),
        createSnapshot({ runId: 'run-2' })
      )
    ).toBe(false);
    expect(
      areMemberSpawnSnapshotsSemanticallyEqual(
        createSnapshot(),
        createSnapshot({ expectedMembers: ['alice', 'bob'] })
      )
    ).toBe(false);
    expect(areMemberSpawnSnapshotsSemanticallyEqual(undefined, createSnapshot())).toBe(false);
  });
});
