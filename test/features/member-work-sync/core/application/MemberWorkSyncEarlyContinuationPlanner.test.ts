import { MemberWorkSyncNudgeOutboxPlanner } from '@features/member-work-sync/core/application';
import { EARLY_CONTINUATION_INTENT_PREFIX } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanHelpers';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '@features/member-work-sync/contracts';
import type {
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
}

function admittingTicket(): MemberWorkSyncRuntimeTicketAdmissionPort {
  return {
    admit: async () => ({ admitted: true, ticketId: 'ticket-1', generation: 1 }),
  };
}

function createDeps(options: {
  ticket?: MemberWorkSyncRuntimeTicketAdmissionPort;
  protocol?: number;
  busy?: boolean;
  status?: MemberWorkSyncStatus;
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
    ...(options.busy
      ? {
          busySignal: {
            isBusy: async () => ({ busy: true, reason: 'pending_tool_approval' }),
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
    expect(stored.get('team-a:bob')?.recoveryHealth?.unresolvedIntentId).toBe(item?.id);
  });

  it('does not allocate when the ticket says the runtime is busy', async () => {
    const { deps, outbox } = createDeps({
      ticket: {
        admit: async () => ({ admitted: false, code: 'busy' }),
      },
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status());
    expect(planned).toEqual({ planned: false, code: 'member_busy' });
    expect(outbox.items.size).toBe(0);
  });

  it('does not treat unknown ticket refusal as idle D0', async () => {
    const { deps, outbox } = createDeps({
      ticket: {
        admit: async () => ({ admitted: false, code: 'unknown' }),
      },
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).plan(status());
    expect(planned).toEqual({ planned: false, code: 'early_continuation_rejected' });
    expect(outbox.items.size).toBe(0);
  });

  it('falls through to ordinary planning when the ticket says not_early', async () => {
    const { deps, outbox } = createDeps({
      ticket: {
        admit: async () => ({ admitted: false, code: 'not_early' }),
      },
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
});
