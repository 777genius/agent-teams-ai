import { MemberWorkSyncNudgeOutboxPlanner } from '@features/member-work-sync/core/application';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncUseCaseDeps } from '@features/member-work-sync/core/application';

function status(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  const { agenda: agendaOverrides, shadow: shadowOverrides, ...statusOverrides } = overrides;
  const agenda = {
    teamName: 'team-a',
    memberName: 'bob',
    generatedAt: '2026-05-06T00:00:00.000Z',
    fingerprint: 'agenda:v1:test',
    items: [
      {
        taskId: 'task-1',
        displayId: '11111111',
        subject: 'Do work',
        kind: 'work' as const,
        assignee: 'bob',
        priority: 'normal' as const,
        reason: 'owned_pending_task',
        evidence: { status: 'pending', owner: 'bob' },
      },
    ],
    diagnostics: [],
  };
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    evaluatedAt: '2026-05-06T00:05:00.000Z',
    diagnostics: ['no_current_report'],
    providerId: 'opencode',
    ...statusOverrides,
    agenda: {
      ...agenda,
      ...agendaOverrides,
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
      triggerReasons: ['turn_settled'],
      ...shadowOverrides,
    },
  };
}

function metrics(): MemberWorkSyncTeamMetrics {
  return {
    teamName: 'team-a',
    generatedAt: '2026-05-06T00:05:00.000Z',
    memberCount: 1,
    stateCounts: {
      caught_up: 0,
      needs_sync: 1,
      still_working: 0,
      blocked: 0,
      inactive: 0,
      unknown: 0,
    },
    actionableItemCount: 1,
    wouldNudgeCount: 1,
    fingerprintChangeCount: 0,
    reportAcceptedCount: 0,
    reportRejectedCount: 0,
    recentEvents: [],
    phase2Readiness: {
      state: 'shadow_ready',
      reasons: [],
      thresholds: {
        minObservedMembers: 1,
        minStatusEvents: 20,
        minObservationHours: 1,
        maxWouldNudgesPerMemberHour: 2,
        maxFingerprintChangesPerMemberHour: 1,
        maxReportRejectionRate: 0.2,
      },
      rates: {
        observationHours: 2,
        statusEventCount: 24,
        wouldNudgesPerMemberHour: 0.5,
        fingerprintChangesPerMemberHour: 0,
        reportRejectionRate: 0,
      },
      diagnostics: [],
    },
  };
}

function itemFromInput(
  input: MemberWorkSyncOutboxEnsureInput,
  status: MemberWorkSyncOutboxItem['status']
): MemberWorkSyncOutboxItem {
  return {
    ...input,
    status,
    attemptGeneration: 0,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

class PlannerOutboxHarness {
  readonly ensureInputs: MemberWorkSyncOutboxEnsureInput[] = [];

  constructor(private readonly existingStatus: MemberWorkSyncOutboxItem['status']) {}

  async ensurePending(input: MemberWorkSyncOutboxEnsureInput) {
    this.ensureInputs.push(input);
    if (this.ensureInputs.length === 1) {
      return {
        ok: true as const,
        outcome: 'existing' as const,
        item: itemFromInput(input, this.existingStatus),
      };
    }
    return {
      ok: true as const,
      outcome: 'created' as const,
      item: itemFromInput(input, 'pending'),
    };
  }

  async countRecentDelivered(): Promise<number> {
    return 0;
  }
}

function createDeps(outbox: PlannerOutboxHarness): MemberWorkSyncUseCaseDeps {
  return {
    clock: { now: () => new Date('2026-05-06T00:05:00.000Z') },
    hash: { sha256Hex: (value) => `hash-${value.length}` },
    agendaSource: {
      loadAgenda: async () => {
        throw new Error('not used');
      },
    },
    statusStore: {
      read: async () => null,
      write: async () => undefined,
      readTeamMetrics: async () => metrics(),
    },
    outboxStore: outbox as never,
  };
}

describe('MemberWorkSyncNudgeOutboxPlanner invariants', () => {
  it.each([
    {
      name: 'turn_settled delivered needs_sync',
      existingStatus: 'delivered' as const,
      triggerReasons: ['turn_settled'],
      state: 'needs_sync' as const,
      hasLease: false,
      expectedRecovery: true,
    },
    {
      name: 'task_changed does not look like a stopped runtime turn',
      existingStatus: 'delivered' as const,
      triggerReasons: ['task_changed'],
      state: 'needs_sync' as const,
      hasLease: false,
      expectedRecovery: false,
    },
    {
      name: 'pending base nudge is not recovered yet',
      existingStatus: 'pending' as const,
      triggerReasons: ['turn_settled'],
      state: 'needs_sync' as const,
      hasLease: false,
      expectedRecovery: false,
    },
    {
      name: 'caught_up status is not recovered',
      existingStatus: 'delivered' as const,
      triggerReasons: ['turn_settled'],
      state: 'caught_up' as const,
      hasLease: false,
      expectedRecovery: false,
    },
    {
      name: 'active accepted lease suppresses recovery',
      existingStatus: 'delivered' as const,
      triggerReasons: ['turn_settled'],
      state: 'needs_sync' as const,
      hasLease: true,
      expectedRecovery: false,
    },
  ])('preserves status-only recovery invariant: $name', async (scenario) => {
    const outbox = new PlannerOutboxHarness(scenario.existingStatus);
    const planner = new MemberWorkSyncNudgeOutboxPlanner(createDeps(outbox));
    const result = await planner.plan(
      status({
        state: scenario.state,
        shadow: {
          reconciledBy: 'queue',
          wouldNudge: scenario.state === 'needs_sync',
          fingerprintChanged: false,
          triggerReasons: scenario.triggerReasons,
        },
        ...(scenario.hasLease
          ? {
              report: {
                accepted: true,
                state: 'still_working',
                teamName: 'team-a',
                memberName: 'bob',
                agendaFingerprint: 'agenda:v1:test',
                reportedAt: '2026-05-06T00:04:00.000Z',
                expiresAt: '2026-05-06T00:10:00.000Z',
              },
            }
          : {}),
      })
    );

    const recoveryInput = outbox.ensureInputs.find((input) =>
      input.payload.workSyncIntentKey?.startsWith('status-only:')
    );
    expect(Boolean(recoveryInput)).toBe(scenario.expectedRecovery);
    if (scenario.expectedRecovery) {
      expect(result.planned).toBe(true);
    }
  });
});
