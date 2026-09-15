import {
  MemberWorkSyncNudgeOutboxPlanner,
  readMemberWorkSyncRuntimeTicket,
} from '@features/member-work-sync/core/application';
import { EARLY_CONTINUATION_INTENT_PREFIX } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanHelpers';
import { pickTeamInboxWorkSyncFields } from '@main/services/team/teamInboxWorkSyncFields';
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

function remainingWorkStatus(): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'still_working',
    evaluatedAt: '2026-05-06T00:05:00.000Z',
    diagnostics: ['lease_still_working'],
    providerId: 'codex',
    statusRevision: {
      incarnation: 'inc-live',
      lineageId: 'lineage-1',
      sequence: 1,
      nonce: 'nonce-1',
    },
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
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-05-06T00:00:00.000Z',
      fingerprint: 'agenda:v1:test',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Do work',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: false,
      fingerprintChanged: false,
      triggerReasons: ['turn_settled'],
    },
    recoveryHealth: {
      schemaVersion: 1,
      episodes: [],
      controlRevision: 1,
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
      needs_sync: 0,
      still_working: 1,
      blocked: 0,
      inactive: 0,
      unknown: 0,
    },
    actionableItemCount: 1,
    wouldNudgeCount: 0,
    fingerprintChangeCount: 0,
    reportAcceptedCount: 1,
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

class CrashOutboxHarness {
  readonly items = new Map<string, MemberWorkSyncOutboxItem>();
  throwOnEnsure = false;
  conflictOnEnsure = false;

  ensurePending(input: MemberWorkSyncOutboxEnsureInput) {
    if (this.throwOnEnsure) {
      throw new Error('outbox write interrupted');
    }
    const existing = this.items.get(input.id);
    if (this.conflictOnEnsure || (existing && existing.payloadHash !== input.payloadHash)) {
      return {
        ok: false as const,
        existingPayloadHash: existing?.payloadHash ?? 'other-hash',
        requestedPayloadHash: input.payloadHash,
        item: existing ?? {
          ...input,
          status: 'pending' as const,
          attemptGeneration: 0,
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        },
      };
    }
    const created: MemberWorkSyncOutboxItem = {
      ...input,
      status: 'pending',
      attemptGeneration: 0,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.items.set(input.id, created);
    return Promise.resolve({ ok: true as const, outcome: 'created' as const, item: created });
  }

  findDeliveredReviewPickupRequestEventIds(): Promise<string[]> {
    return Promise.resolve([]);
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
    cancel: () => Promise.resolve(),
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

function createDeps(options: {
  ticket?: MemberWorkSyncRuntimeTicketAdmissionPort;
  outbox?: CrashOutboxHarness;
}): {
  deps: MemberWorkSyncUseCaseDeps;
  outbox: CrashOutboxHarness;
  stored: Map<string, MemberWorkSyncStatus>;
} {
  const outbox = options.outbox ?? new CrashOutboxHarness();
  const current = remainingWorkStatus();
  const stored = new Map<string, MemberWorkSyncStatus>([['team-a:bob', current]]);
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
    recoveryProtocol: { version: 2 },
    runtimeTicketAdmission: options.ticket ?? admittingTicket(),
  };
  return { deps, outbox, stored };
}

describe('work-sync admission crash windows', () => {
  it('cancels the same ticket when CAS/outbox definitively conflicts', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
    const outbox = new CrashOutboxHarness();
    outbox.conflictOnEnsure = true;
    const { deps } = createDeps({
      outbox,
      ticket: admittingTicket({
        cancel: (ticket) => {
          cancelled.push(ticket);
          return Promise.resolve();
        },
      }),
    });
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      remainingWorkStatus(),
      settlement
    );
    expect(planned).toEqual({ planned: false, code: 'payload_conflict' });
    expect(cancelled).toEqual([
      expect.objectContaining({ ticketId: 'ticket-1', expectedGeneration: 1 }),
    ]);
  });

  it('does not mint a new ticket when outbox persist outcome is unknown', async () => {
    const cancelled: MemberWorkSyncRuntimeTicket[] = [];
    const outbox = new CrashOutboxHarness();
    outbox.throwOnEnsure = true;
    const { deps } = createDeps({
      outbox,
      ticket: admittingTicket({
        cancel: (ticket) => {
          cancelled.push(ticket);
          return Promise.resolve();
        },
      }),
    });
    await expect(
      new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
        remainingWorkStatus(),
        settlement
      )
    ).rejects.toThrow('outbox write interrupted');
    expect(cancelled).toEqual([]);
    expect(outbox.items.size).toBe(0);
  });

  it('reconstructs the reserved ticket from durable outbox bytes after restart', async () => {
    const { deps, outbox } = createDeps({});
    const planned = await new MemberWorkSyncNudgeOutboxPlanner(deps).planEarlyContinuation(
      remainingWorkStatus(),
      settlement
    );
    expect(planned.planned).toBe(true);
    const item = [...outbox.items.values()][0];
    expect(item).toBeDefined();
    if (!item) {
      return;
    }
    expect(item.payload.workSyncIntentKey?.startsWith(`${EARLY_CONTINUATION_INTENT_PREFIX}:`)).toBe(
      true
    );
    const cloned: MemberWorkSyncOutboxItem = JSON.parse(JSON.stringify(item));
    expect(readMemberWorkSyncRuntimeTicket(cloned)).toEqual(readMemberWorkSyncRuntimeTicket(item));
    expect(readMemberWorkSyncRuntimeTicket(cloned)).toMatchObject({
      ticketId: 'ticket-1',
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 1,
      teamIncarnation: 'inc-live',
    });
    expect(
      pickTeamInboxWorkSyncFields({
        ...cloned.payload,
        workSyncRuntimeTicketId: cloned.payload.workSyncRuntimeTicketId,
      })
    ).toMatchObject({
      workSyncRuntimeTicketId: 'ticket-1',
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncRuntimeGeneration: 1,
      workSyncTeamIncarnation: 'inc-live',
    });
  });
});
