import {
  insertMemberWorkSyncInboxAfterRuntimeTicket,
  MemberWorkSyncNudgeOutboxPlanner,
} from '@features/member-work-sync/core/application';
import { EARLY_CONTINUATION_INTENT_PREFIX } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanHelpers';
import {
  rememberMemberWorkSyncLastSettlement,
  resetMemberWorkSyncLastSettlements,
} from '@features/member-work-sync/core/application/memberWorkSyncSettlementReplay';
import { applyMemberWorkSyncTerminalRetirement } from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryTerminal';
import { afterEach, describe, expect, it } from 'vitest';

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

function remainingWorkStatus(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return status({
    state: 'still_working',
    diagnostics: ['lease_still_working'],
    lastAcceptedReport: {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: 'agenda:v1:test',
      reportedAt: '2026-05-06T00:04:00.000Z',
      expiresAt: '2026-05-06T00:20:00.000Z',
      accepted: true,
      source: 'mcp',
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: false,
      fingerprintChanged: false,
      triggerReasons: ['turn_settled'],
    },
    ...overrides,
  });
}

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
    deliveryReadiness: {
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

  async readItem(input: { id: string }) {
    return this.items.get(input.id) ?? null;
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
    admit: async (input) => ({
      admitted: true,
      ticket: {
        teamName: input.teamName,
        teamIncarnation: input.teamIncarnation,
        memberName: input.memberName,
        runtimeInstanceId: input.runtimeInstanceId ?? 'runtime-1',
        expectedGeneration: input.expectedGeneration,
        ticketId: 'ticket-1',
        intentId: input.intentId,
        controlRevision: input.controlRevision,
        admissionPayloadHash: input.admissionPayloadHash,
      },
    }),
    cancel: async () => undefined,
    ...overrides,
  };
}

const settlement = {
  sourceId: 'settled-1',
  recordedAt: '2026-05-06T00:05:00.000Z',
  runtimeInstanceId: 'runtime-1',
  completedGeneration: 1,
  outcome: 'success' as const,
};

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
            canBypassDeliveryReadiness: true,
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
  afterEach(() => {
    resetMemberWorkSyncLastSettlements();
  });
  it('stays disabled on protocol 1 even when a ticket port exists', async () => {
    const { deps, outbox } = createDeps({
      protocol: 1,
      ticket: admittingTicket(),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(status(), settlement);
    expect(planned).toEqual({ planned: false, code: 'early_continuation_disabled' });
    expect(outbox.items.size).toBe(0);
  });

  it('reserves remaining-work continuation while a still_working lease would block D0', async () => {
    const current = remainingWorkStatus();
    const { deps, outbox } = createDeps({ ticket: admittingTicket(), status: current });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current, settlement);
    expect(planned).toMatchObject({ planned: true, code: 'created' });
    expect([...outbox.items.values()][0]?.payload.workSyncIntentKey).toBe(
      `${EARLY_CONTINUATION_INTENT_PREFIX}:legacy:${current.agenda.fingerprint}:runtime-1:1`
    );
  });

  it('handshakes control with the same lifecycle incarnation used for admit', async () => {
    const handshakes: { teamIncarnation?: string }[] = [];
    const current = remainingWorkStatus({
      statusRevision: {
        incarnation: 'inc-live',
        lineageId: 'line-1',
        sequence: 1,
        nonce: 'nonce-1',
      },
    });
    const { deps, outbox } = createDeps({
      status: current,
      ticket: admittingTicket({
        syncControl: async (input) => {
          handshakes.push({ teamIncarnation: input.teamIncarnation });
          return { ok: true as const, code: 'open' as const, controlRevision: input.controlRevision };
        },
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      current,
      settlement
    );
    expect(planned).toMatchObject({ planned: true, code: 'created' });
    expect(handshakes).toEqual([{ teamIncarnation: 'inc-live' }]);
    expect([...outbox.items.values()][0]?.payload.workSyncTeamIncarnation).toBe('inc-live');
  });

  it('reserves one early continuation after the runtime ticket admits', async () => {
    const current = remainingWorkStatus();
    const { deps, outbox, stored } = createDeps({ ticket: admittingTicket(), status: current });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current, settlement);
    expect(planned).toMatchObject({ planned: true, code: 'created' });
    const item = [...outbox.items.values()][0];
    expect(item?.payload.workSyncIntentKey).toBe(
      `${EARLY_CONTINUATION_INTENT_PREFIX}:legacy:${current.agenda.fingerprint}:runtime-1:1`
    );
    expect(item?.payload.workSyncRuntimeTicketId).toBe('ticket-1');
    expect(item?.payload.workSyncRuntimeGeneration).toBe(1);
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).toBe(item?.id);
  });

  it('does not reuse a consumed settlement for a new agenda fingerprint', async () => {
    const current = remainingWorkStatus();
    const { deps, outbox, stored } = createDeps({ ticket: admittingTicket(), status: current });
    const planner = new MemberWorkSyncNudgeOutboxPlanner(deps);
    await expect(planner.planEarlyContinuation(current, settlement)).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    const firstId = [...outbox.items.keys()][0];
    const changed = remainingWorkStatus({
      agenda: { ...current.agenda, fingerprint: 'agenda:v2:changed' },
      lastAcceptedReport: {
        ...current.lastAcceptedReport!,
        agendaFingerprint: 'agenda:v2:changed',
      },
      recoveryHealth: stored.get('team-a:bob')?.recoveryHealth,
    });
    stored.set('team-a:bob', changed);
    await expect(planner.planEarlyContinuation(changed, settlement)).resolves.toEqual({
      planned: false,
      code: 'early_continuation_rejected',
    });
    expect(outbox.items.size).toBe(1);
    expect(outbox.items.has(firstId!)).toBe(true);
  });

  it('does not reopen a completed generation when the same turn is re-emitted with a new sourceId', async () => {
    const current = remainingWorkStatus();
    const { deps, outbox, stored } = createDeps({ ticket: admittingTicket(), status: current });
    const planner = new MemberWorkSyncNudgeOutboxPlanner(deps);
    await expect(planner.planEarlyContinuation(current, settlement)).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    const firstId = [...outbox.items.keys()][0];
    const first = outbox.items.get(firstId!);
    if (first) {
      first.status = 'delivered';
    }
    const changed = remainingWorkStatus({
      agenda: { ...current.agenda, fingerprint: 'agenda:v2:changed' },
      lastAcceptedReport: {
        ...current.lastAcceptedReport!,
        agendaFingerprint: 'agenda:v2:changed',
      },
      recoveryHealth: applyMemberWorkSyncTerminalRetirement({
        health: stored.get('team-a:bob')?.recoveryHealth,
        intentId: firstId!,
        receiptId: 'matched-completion',
        pendingAck: false,
      }),
    });
    stored.set('team-a:bob', changed);
    rememberMemberWorkSyncLastSettlement({
      teamName: current.teamName,
      memberName: current.memberName,
      settlement: {
        ...settlement,
        sourceId: 'settled-1-reobserved',
        recordedAt: '2026-05-06T00:06:00.000Z',
      },
    });
    await expect(
      planner.planEarlyContinuation(changed, {
        ...settlement,
        sourceId: 'settled-1-reobserved',
        recordedAt: '2026-05-06T00:06:00.000Z',
      })
    ).resolves.toEqual({
      planned: false,
      code: 'early_continuation_rejected',
    });
    expect(outbox.items.size).toBe(1);
    expect([...outbox.items.values()][0]?.payload.workSyncRuntimeGeneration).toBe(1);
  });

  it('allows a later completed generation on the same runtime after the previous attempt settled', async () => {
    const current = remainingWorkStatus();
    const { deps, outbox, stored } = createDeps({ ticket: admittingTicket(), status: current });
    const planner = new MemberWorkSyncNudgeOutboxPlanner(deps);
    await expect(planner.planEarlyContinuation(current, settlement)).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    const firstId = [...outbox.items.keys()][0];
    const changed = remainingWorkStatus({
      agenda: { ...current.agenda, fingerprint: 'agenda:v2:changed' },
      lastAcceptedReport: {
        ...current.lastAcceptedReport!,
        agendaFingerprint: 'agenda:v2:changed',
      },
      recoveryHealth: applyMemberWorkSyncTerminalRetirement({
        health: stored.get('team-a:bob')?.recoveryHealth,
        intentId: firstId!,
        receiptId: 'matched-completion',
        pendingAck: false,
      }),
    });
    stored.set('team-a:bob', changed);
    await expect(
      planner.planEarlyContinuation(changed, {
        ...settlement,
        sourceId: 'settled-2',
        recordedAt: '2026-05-06T00:06:00.000Z',
        completedGeneration: 2,
      })
    ).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    expect(outbox.items.size).toBe(2);
  });

  it('retries an unfinished same-intent continuation without minting a second outbox item', async () => {
    const current = remainingWorkStatus();
    const inner = admittingTicket();
    const admits: string[] = [];
    const { deps, outbox, stored } = createDeps({
      ticket: admittingTicket({
        admit: async (input) => {
          admits.push(input.intentId);
          return inner.admit(input);
        },
      }),
      status: current,
    });
    const planner = new MemberWorkSyncNudgeOutboxPlanner(deps);
    await expect(planner.planEarlyContinuation(current, settlement)).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    const retryStatus = remainingWorkStatus({
      recoveryHealth: stored.get('team-a:bob')?.recoveryHealth,
    });
    stored.set('team-a:bob', retryStatus);
    await expect(planner.planEarlyContinuation(retryStatus, settlement)).resolves.toEqual({
      planned: true,
      code: 'existing',
    });
    expect(outbox.items.size).toBe(1);
    expect([...outbox.items.values()][0]?.status).toBe('pending');
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).toBe(
      [...outbox.items.keys()][0]
    );
    expect(admits).toHaveLength(2);
  });

  it('rejects a completed same-intent refresh before admission so a later generation can occupy the lane', async () => {
    const current = remainingWorkStatus();
    const inner = admittingTicket();
    const admits: string[] = [];
    const cancelled: string[] = [];
    const { deps, outbox, stored } = createDeps({
      ticket: admittingTicket({
        admit: async (input) => {
          admits.push(input.intentId);
          return inner.admit(input);
        },
        cancel: async (ticket) => {
          cancelled.push(ticket.ticketId);
        },
      }),
      status: current,
    });
    const planner = new MemberWorkSyncNudgeOutboxPlanner(deps);
    await expect(planner.planEarlyContinuation(current, settlement)).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    const firstId = [...outbox.items.keys()][0];
    const first = outbox.items.get(firstId!);
    if (first) {
      first.status = 'delivered';
    }
    const completed = remainingWorkStatus({
      recoveryHealth: applyMemberWorkSyncTerminalRetirement({
        health: stored.get('team-a:bob')?.recoveryHealth,
        intentId: firstId!,
        receiptId: 'matched-completion',
        pendingAck: false,
      }),
    });
    stored.set('team-a:bob', completed);
    rememberMemberWorkSyncLastSettlement({
      teamName: current.teamName,
      memberName: current.memberName,
      settlement: {
        ...settlement,
        sourceId: 'settled-1-refresh',
        recordedAt: '2026-05-06T00:06:00.000Z',
      },
    });
    await expect(
      planner.planEarlyContinuation(completed, {
        ...settlement,
        sourceId: 'settled-1-refresh',
        recordedAt: '2026-05-06T00:06:00.000Z',
      })
    ).resolves.toEqual({
      planned: false,
      code: 'early_continuation_rejected',
    });
    expect(admits).toHaveLength(1);
    expect(cancelled).toEqual([]);
    expect(outbox.items.size).toBe(1);
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).toBeUndefined();
    expect(
      stored.get('team-a:bob')?.recoveryHealth?.reservations?.some(
        (reservation) => reservation.intentId === firstId && reservation.state === 'reserved'
      )
    ).toBe(false);
    await expect(
      planner.planEarlyContinuation(completed, {
        ...settlement,
        sourceId: 'settled-8',
        recordedAt: '2026-05-06T00:07:00.000Z',
        completedGeneration: 8,
      })
    ).resolves.toMatchObject({
      planned: true,
      code: 'created',
    });
    expect(admits).toHaveLength(2);
    expect(outbox.items.size).toBe(2);
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).not.toBe(firstId);
  });

  it('does not allocate when the ticket says the runtime is busy', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'busy' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'member_busy' });
    expect(outbox.items.size).toBe(0);
  });

  it('does not treat unknown ticket refusal as idle D0', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'unknown' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'early_continuation_rejected' });
    expect(outbox.items.size).toBe(0);
  });

  it('falls through to ordinary planning when the ticket says not_early', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        admit: async () => ({ admitted: false, code: 'not_early' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status(), settlement);
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
      remainingWorkStatus(),
      settlement
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
    const current = remainingWorkStatus();
    await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(current, settlement);
    expect(outbox.items.size).toBe(0);
    expect(cancelled).toEqual([
      expect.objectContaining({ ticketId: 'ticket-1', expectedGeneration: 1 }),
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
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current, settlement);
    expect(admitted).toBe(false);
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
    await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(current);
    expect(outbox.findDeliveredCalls).toBeGreaterThan(0);
    expect(outbox.items.size).toBe(0);
  });

    it('cancels an admitted ticket when a later planner check throws', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        cancel: async (ticket) => {
          cancelled.push(ticket);
        },
      }),
      busy: true,
    });
    deps.busySignal = {
      isBusy: async () => {
        throw new Error('busy lookup failed');
      },
    };
    await expect(
      new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
        remainingWorkStatus(),
        settlement
      )
    ).rejects.toThrow('busy lookup failed');
    expect(outbox.items.size).toBe(0);
    expect(cancelled).toEqual([expect.objectContaining({ ticketId: 'ticket-1', expectedGeneration: 1 })]);
  });

  it('cancels a started ticket when stop aborts before inbox insert', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
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
          workSyncRuntimeInstanceId: 'runtime-1',
          text: 'continue',
          taskRefs: [],
        },
      },
      'pending'
    );
    await expect(
      insertMemberWorkSyncInboxAfterRuntimeTicket({
        admission: admittingTicket({
          cancel: async (ticket) => {
            cancelled.push(ticket);
          },
        }),
        inbox: {
          insertIfAbsent: async () => {
            throw new Error('inbox insert must not run after abort');
          },
        },
        item,
        nowIso: '2026-05-06T00:05:00.000Z',
        shouldAbort: () => true,
      })
    ).resolves.toEqual({ status: 'aborted' });
    expect(cancelled).toEqual([expect.objectContaining({ ticketId: 'ticket-1', expectedGeneration: 1 })]);
  });

  it('cancels a started ticket when inbox insert conflicts after start', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
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
          workSyncRuntimeInstanceId: 'runtime-1',
          text: 'continue',
          taskRefs: [],
        },
      },
      'pending'
    );
    await expect(
      insertMemberWorkSyncInboxAfterRuntimeTicket({
        admission: admittingTicket({
          cancel: async (ticket) => {
            cancelled.push(ticket);
          },
        }),
        inbox: {
          insertIfAbsent: async () => ({
            inserted: false,
            messageId: item.id,
            conflict: true,
          }),
        },
        item,
        nowIso: '2026-05-06T00:05:00.000Z',
        shouldAbort: () => false,
      })
    ).resolves.toEqual({ status: 'conflict' });
    expect(cancelled).toEqual([expect.objectContaining({ ticketId: 'ticket-1', expectedGeneration: 1 })]);
  });

  it('does not admit when runtime control handshake is unknown', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        syncControl: async () => ({ ok: false, code: 'unknown' }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'early_continuation_rejected' });
    expect(outbox.items.size).toBe(0);
  });

  it('does not admit when runtime control is closed', async () => {
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        syncControl: async () => ({ ok: true, code: 'closed', controlRevision: 4 }),
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'member_stopped' });
    expect(outbox.items.size).toBe(0);
  });

  it('does not handshake open when live control is already stopped', async () => {
    const handshakes: unknown[] = [];
    const { deps, outbox } = createDeps({
      ticket: admittingTicket({
        readLiveControl: async () => ({
          runtimeInstanceId: 'runtime-1',
          controlRevision: 2,
          stopped: true,
          handshakeCompleted: true,
        }),
        syncControl: async (input) => {
          handshakes.push(input);
          return { ok: true as const, code: 'open' as const, controlRevision: input.controlRevision };
        },
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'member_stopped' });
    expect(handshakes).toEqual([]);
    expect(outbox.items.size).toBe(0);
  });

  it('does not insert inbox when the persisted runtime ticket is no longer reserved', async () => {
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
          workSyncRuntimeInstanceId: 'runtime-1',
          workSyncAdmissionPayloadHash: 'hash-1',
          text: 'continue',
          taskRefs: [],
        },
      },
      'pending'
    );
    const cancelled: string[] = [];
    await expect(
      insertMemberWorkSyncInboxAfterRuntimeTicket({
        admission: admittingTicket({
          confirmReserved: async () => ({ ok: false, code: 'stale' }),
          cancel: async (ticket) => {
            cancelled.push(ticket.ticketId);
          },
        }),
        inbox: {
          insertIfAbsent: async () => {
            throw new Error('inbox insert must not run for a stale ticket');
          },
        },
        item,
        nowIso: '2026-05-06T00:05:00.000Z',
        shouldAbort: () => false,
      })
    ).resolves.toEqual({ status: 'stale' });
    expect(cancelled).toEqual(['ticket-1']);
  });

  it('keeps a confirmReserved unknown ticket retryable', async () => {
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
          workSyncRuntimeInstanceId: 'runtime-1',
          workSyncAdmissionPayloadHash: 'hash-1',
          text: 'continue',
          taskRefs: [],
        },
      },
      'pending'
    );
    await expect(
      insertMemberWorkSyncInboxAfterRuntimeTicket({
        admission: admittingTicket({
          confirmReserved: async () => ({ ok: false, code: 'unknown' }),
        }),
        inbox: {
          insertIfAbsent: async () => {
            throw new Error('inbox insert must not run for an unknown ticket');
          },
        },
        item,
        nowIso: '2026-05-06T00:05:00.000Z',
        shouldAbort: () => false,
      })
    ).resolves.toEqual({ status: 'busy' });
  });
});
