import {
  MemberWorkSyncNudgeOutboxPlanner,
  startMemberWorkSyncRuntimeTicketForOutboxItem,
} from '@features/member-work-sync/core/application';
import { EARLY_CONTINUATION_INTENT_PREFIX } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanHelpers';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '@features/member-work-sync/contracts';
import type {
  MemberWorkSyncRuntimeTicket,
  MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application';

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
    providerId: 'codex',
    ...statusOverrides,
    agenda: {
      ...agenda,
      ...agendaOverrides,
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
      triggerReasons: ['task_changed'],
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
  itemStatus: MemberWorkSyncOutboxItem['status']
): MemberWorkSyncOutboxItem {
  return {
    ...input,
    status: itemStatus,
    attemptGeneration: 0,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

class PlannerOutboxHarness {
  readonly items = new Map<string, MemberWorkSyncOutboxItem>();
  deliveredReviewRequestEventIds: string[] = [];
  findDeliveredCalls = 0;

  async ensurePending(input: MemberWorkSyncOutboxEnsureInput) {
    const existing = this.items.get(input.id);
    if (existing && existing.payloadHash !== input.payloadHash) {
      return {
        ok: false as const,
        existingPayloadHash: existing.payloadHash,
        requestedPayloadHash: input.payloadHash,
        item: existing,
      };
    }
    if (existing) {
      return { ok: true as const, outcome: 'existing' as const, item: existing };
    }
    const created = itemFromInput(input, 'pending');
    this.items.set(input.id, created);
    return { ok: true as const, outcome: 'created' as const, item: created };
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    this.findDeliveredCalls += 1;
    const requested = new Set(input.reviewRequestEventIds);
    return this.deliveredReviewRequestEventIds.filter((eventId) => requested.has(eventId));
  }
}

function admittingTicket(
  overrides: Partial<MemberWorkSyncRuntimeTicketAdmissionPort> = {}
): MemberWorkSyncRuntimeTicketAdmissionPort {
  return {
    admit: async () => ({ admitted: true, ticketId: 'ticket-1', generation: 1 }),
    start: async () => ({ ok: true }),
    cancel: async () => undefined,
    ...overrides,
  };
}

function reviewPickupStatus(): MemberWorkSyncStatus {
  return status({
    providerId: 'opencode',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-05-06T00:00:00.000Z',
      fingerprint: 'agenda:v1:review',
      items: [
        {
          taskId: 'task-review',
          displayId: '22222222',
          subject: 'Review docs',
          kind: 'review',
          assignee: 'bob',
          priority: 'review_requested',
          reason: 'current_cycle_review_assigned',
          evidence: {
            status: 'completed',
            owner: 'alice',
            reviewer: 'bob',
            reviewState: 'review',
            reviewCycleId: 'evt-reviewed-once',
            reviewRequestEventId: 'evt-reviewed-once',
            reviewObligation: 'review_pickup_required',
            canBypassPhase2: true,
            historyEventIds: ['evt-reviewed-once'],
          },
        },
      ],
      diagnostics: [],
    },
  });
}

function createDeps(options: {
  ticket?: MemberWorkSyncRuntimeTicketAdmissionPort;
  protocol?: number;
  busy?: boolean | { reason: string };
  status?: MemberWorkSyncStatus;
  reviewPickupDelivery?: boolean;
}): {
  deps: MemberWorkSyncUseCaseDeps;
  outbox: PlannerOutboxHarness;
  stored: Map<string, MemberWorkSyncStatus>;
} {
  const outbox = new PlannerOutboxHarness();
  const current = options.status ?? status();
  const stored = new Map<string, MemberWorkSyncStatus>([
    [`${current.teamName}:${current.memberName}`, current],
  ]);
  const busy = options.busy
    ? typeof options.busy === 'boolean'
      ? { busy: true as const, reason: 'pending_tool_approval' }
      : { busy: true as const, reason: options.busy.reason }
    : null;
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date('2026-05-06T00:05:00.000Z') },
    hash: { sha256Hex: (value) => `hash-${value.length}` },
    agendaSource: {
      loadAgenda: async () => {
        throw new Error('not used');
      },
    },
    statusStore: {
      read: async (request) => stored.get(`${request.teamName}:${request.memberName}`) ?? null,
      write: async (next) => {
        stored.set(`${next.teamName}:${next.memberName}`, next);
      },
      readTeamMetrics: async () => metrics(),
    },
    outboxStore: outbox as never,
    recoveryAllocation: { enabled: true },
    recoveryProtocol: { version: options.protocol ?? 2 },
    ...(options.ticket ? { runtimeTicketAdmission: options.ticket } : {}),
    ...(busy
      ? {
          busySignal: {
            isBusy: async () => busy,
          },
        }
      : {}),
    ...(options.reviewPickupDelivery
      ? {
          reviewPickupDelivery: {
            canDeliver: async () => ({ ok: true as const }),
            deliver: async () => {
              throw new Error('not used');
            },
          },
        }
      : {}),
  };
  return { deps, outbox, stored };
}

describe('protocol-2 early continuation', () => {
  it('stays disabled on protocol 1 even when a ticket port exists', async () => {
    const { deps, outbox } = createDeps({
      protocol: 1,
      ticket: admittingTicket(),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      status()
    );
    expect(planned).toEqual({ planned: false, code: 'early_continuation_disabled' });
    expect(outbox.items.size).toBe(0);
  });

  it('reserves one early continuation after the runtime ticket admits', async () => {
    const current = status();
    const { deps, outbox, stored } = createDeps({ ticket: admittingTicket(), status: current });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current);
    expect(planned).toMatchObject({ planned: true, code: 'created' });
    const item = [...outbox.items.values()][0];
    expect(item?.payload.workSyncIntentKey).toBe(
      `${EARLY_CONTINUATION_INTENT_PREFIX}:${current.agenda.fingerprint}`
    );
    expect(item?.payload.workSyncRuntimeTicketId).toBe('ticket-1');
    expect(item?.payload.workSyncRuntimeGeneration).toBe(1);
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).toBe(item?.id);
  });

  it('does not allocate when the ticket says the runtime is busy', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'busy' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status());
    expect(planned).toEqual({ planned: false, code: 'member_busy' });
    expect(outbox.items.size).toBe(0);
  });

  it('does not treat unknown ticket refusal as idle D0', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'unknown' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status());
    expect(planned).toEqual({ planned: false, code: 'early_continuation_rejected' });
    expect(outbox.items.size).toBe(0);
  });

  it('falls through to ordinary planning when the ticket says not_early', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'not_early' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status());
    expect(planned.planned).toBe(true);
    const keys = [...outbox.items.values()].map((item) => item.payload.workSyncIntentKey);
    expect(keys.some((key) => key?.startsWith(`${EARLY_CONTINUATION_INTENT_PREFIX}:`))).toBe(false);
  });

  it('refuses early continuation while a desktop busy signal is set', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket(),
      busy: true,
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      status()
    );
    expect(planned).toEqual({ planned: false, code: 'member_busy' });
    expect(outbox.items.size).toBe(0);
  });

  it('cancels an admitted ticket when desktop busy blocks persistence', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        cancel: async (ticket) => {
          cancelled.push(ticket);
        },
      }),
      busy: true,
    });
    const current = status();
    await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(current);
    expect(outbox.items.size).toBe(0);
    expect(cancelled).toEqual([
      expect.objectContaining({ ticketId: 'ticket-1', generation: 1 }),
    ]);
  });

  it('falls through to D0 when not_early even if recent tool activity is busy', async () => {
    let admitted = false;
    const current = status({
      shadow: {
        reconciledBy: 'queue',
        wouldNudge: true,
        fingerprintChanged: false,
        triggerReasons: ['turn_settled'],
      },
    });
    const { deps, outbox } = createDeps({
      status: current,
      busy: { reason: 'recent_tool_activity' },
      ticket: admittingTicket({
        admit: async () => {
          admitted = true;
          return { admitted: false, code: 'not_early' };
        },
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current);
    expect(admitted).toBe(true);
    expect(planned).not.toEqual({ planned: false, code: 'member_busy' });
    expect(planned.planned).toBe(true);
    const keys = [...outbox.items.values()].map((item) => item.payload.workSyncIntentKey);
    expect(keys.some((key) => key?.startsWith(`${EARLY_CONTINUATION_INTENT_PREFIX}:`))).toBe(false);
  });

  it('deduplicates a delivered review request before admitting D1', async () => {
    const current = reviewPickupStatus();
    const { deps, outbox } = createDeps({
      ticket: admittingTicket(),
      status: current,
      reviewPickupDelivery: true,
    });
    outbox.deliveredReviewRequestEventIds = ['evt-reviewed-once'];
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current);
    expect(planned).toEqual({
      planned: false,
      code: 'review_pickup_already_delivered_still_stuck',
    });
    expect(outbox.findDeliveredCalls).toBeGreaterThan(0);
    expect(outbox.items.size).toBe(0);
  });

  it('starts an admitted runtime ticket and refuses a stale one', async () => {
    const item = itemFromInput(
      {
        id: 'member-work-sync:team-a:bob:early-continuation:agenda:v1:test',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:test',
        payloadHash: 'hash-1',
        nowIso: '2026-05-06T00:05:00.000Z',
        payload: {
          from: 'system',
          to: 'bob',
          messageKind: 'member_work_sync_nudge',
          source: 'member-work-sync',
          actionMode: 'do',
          workSyncIntent: 'agenda_sync',
          workSyncIntentKey: `${EARLY_CONTINUATION_INTENT_PREFIX}:agenda:v1:test`,
          workSyncRuntimeTicketId: 'ticket-1',
          workSyncRuntimeGeneration: 1,
          text: 'continue',
          taskRefs: [],
        },
      },
      'pending'
    );
    await expect(
      startMemberWorkSyncRuntimeTicketForOutboxItem(admittingTicket(), item)
    ).resolves.toEqual({ ok: true });
    await expect(
      startMemberWorkSyncRuntimeTicketForOutboxItem(
        admittingTicket({
          start: async () => ({ ok: false, code: 'stale' }),
        }),
        item
      )
    ).resolves.toEqual({ ok: false, code: 'stale' });
    await expect(startMemberWorkSyncRuntimeTicketForOutboxItem(undefined, item)).resolves.toEqual({
      ok: false,
      code: 'stale',
    });
  });
});
