import {
  type MemberWorkSyncAgendaSourceResult,
  type MemberWorkSyncAuditEvent,
  MemberWorkSyncDiagnosticsReader,
  type MemberWorkSyncInboxNudgePort,
  MemberWorkSyncNudgeDispatcher,
  type MemberWorkSyncOutboxStorePort,
  MemberWorkSyncPendingReportIntentReplayer,
  MemberWorkSyncReconciler,
  MemberWorkSyncReporter,
  type MemberWorkSyncReviewPickupDeliveryPort,
  type MemberWorkSyncReviewPickupEscalationPort,
  type MemberWorkSyncStatusStorePort,
  type MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncActionableWorkItem,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncPhase2ReadinessState,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '@features/member-work-sync/contracts';

const workItem: MemberWorkSyncActionableWorkItem = {
  taskId: 'task-1',
  displayId: '11111111',
  subject: 'Ship sync',
  kind: 'work',
  assignee: 'bob',
  priority: 'normal',
  reason: 'owned_pending_task',
  evidence: {
    status: 'pending',
    owner: 'bob',
  },
};

const reviewPickupItem: MemberWorkSyncActionableWorkItem = {
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
    reviewCycleId: 'evt-review-request',
    reviewRequestEventId: 'evt-review-request',
    reviewObligation: 'review_pickup_required',
    canBypassPhase2: true,
    historyEventIds: ['evt-review-request'],
  },
};

const secondReviewPickupItem: MemberWorkSyncActionableWorkItem = {
  ...reviewPickupItem,
  taskId: 'task-review-b',
  displayId: '33333333',
  subject: 'Review API',
  evidence: {
    ...reviewPickupItem.evidence,
    reviewCycleId: 'evt-review-request-b',
    reviewRequestEventId: 'evt-review-request-b',
    historyEventIds: ['evt-review-request-b'],
  },
};

class MutableClock {
  private current = new Date('2026-04-29T00:00:00.000Z');

  now(): Date {
    return this.current;
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

class InMemoryStatusStore implements MemberWorkSyncStatusStorePort {
  readonly writes: MemberWorkSyncStatus[] = [];
  readonly pendingReports: Array<{ request: MemberWorkSyncReportRequest; reason: string }> = [];
  readonly pendingIntents = new Map<string, MemberWorkSyncReportIntent>();
  phase2ReadinessState: MemberWorkSyncPhase2ReadinessState = 'collecting_shadow_data';

  async read(): Promise<MemberWorkSyncStatus | null> {
    return this.writes.at(-1) ?? null;
  }

  async write(status: MemberWorkSyncStatus): Promise<void> {
    this.writes.push(status);
  }

  async appendPendingReport(request: MemberWorkSyncReportRequest, reason: string): Promise<void> {
    this.pendingReports.push({ request, reason });
  }

  async listPendingReports(): Promise<MemberWorkSyncReportIntent[]> {
    return [...this.pendingIntents.values()].filter((intent) => intent.status === 'pending');
  }

  async markPendingReportProcessed(
    _teamName: string,
    id: string,
    result: {
      status: MemberWorkSyncReportIntent['status'];
      resultCode: string;
      processedAt: string;
    }
  ): Promise<void> {
    const current = this.pendingIntents.get(id);
    if (current) {
      this.pendingIntents.set(id, { ...current, ...result });
    }
  }

  async readTeamMetrics(teamName: string): Promise<MemberWorkSyncTeamMetrics> {
    return {
      teamName,
      generatedAt: '2026-04-29T00:00:00.000Z',
      memberCount: 1,
      stateCounts: {
        caught_up: 0,
        needs_sync: 1,
        still_working: 0,
        blocked: 0,
        inactive: 0,
        unknown: 0,
      },
      actionableItemCount: this.writes.at(-1)?.agenda.items.length ?? 0,
      wouldNudgeCount: 1,
      fingerprintChangeCount: 0,
      reportAcceptedCount: 0,
      reportRejectedCount: 0,
      recentEvents: [],
      phase2Readiness: {
        state: this.phase2ReadinessState,
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
          statusEventCount: 30,
          wouldNudgesPerMemberHour: 0.5,
          fingerprintChangesPerMemberHour: 0,
          reportRejectionRate: 0,
        },
        diagnostics: [],
      },
    };
  }
}

class InMemoryOutboxStore implements MemberWorkSyncOutboxStorePort {
  readonly ensures: MemberWorkSyncOutboxEnsureInput[] = [];
  readonly items = new Map<string, MemberWorkSyncOutboxItem>();
  rejectPayloadConflicts = false;

  async ensurePending(input: MemberWorkSyncOutboxEnsureInput) {
    this.ensures.push(input);
    const current = this.items.get(input.id);
    if (current) {
      if (this.rejectPayloadConflicts && current.payloadHash !== input.payloadHash) {
        return {
          ok: false as const,
          outcome: 'payload_conflict' as const,
          item: current,
          existingPayloadHash: current.payloadHash,
          requestedPayloadHash: input.payloadHash,
        };
      }
      if (current.status === 'superseded') {
        const revived = {
          ...current,
          status: 'pending' as const,
          updatedAt: input.nowIso,
        };
        delete revived.lastError;
        delete revived.claimedBy;
        delete revived.claimedAt;
        this.items.set(input.id, revived);
        return { ok: true as const, outcome: 'existing' as const, item: revived };
      }
      return { ok: true as const, outcome: 'existing' as const, item: current };
    }
    const item: MemberWorkSyncOutboxItem = {
      ...input,
      status: 'pending',
      attemptGeneration: 0,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.items.set(input.id, item);
    return { ok: true as const, outcome: 'created' as const, item };
  }

  async claimDue(): Promise<MemberWorkSyncOutboxItem[]> {
    const due = [...this.items.values()].filter((item) => item.status === 'pending');
    for (const item of due) {
      this.items.set(item.id, {
        ...item,
        status: 'claimed',
        attemptGeneration: item.attemptGeneration + 1,
      });
    }
    return due.map((item) => this.items.get(item.id) as MemberWorkSyncOutboxItem);
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    const current = this.items.get(input.id);
    if (current?.attemptGeneration === input.attemptGeneration) {
      this.items.set(input.id, {
        ...current,
        status: 'delivered',
        deliveredMessageId: input.deliveredMessageId,
        ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
        ...(input.deliveryDiagnostics ? { deliveryDiagnostics: input.deliveryDiagnostics } : {}),
        updatedAt: input.nowIso,
      });
    }
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    const current = this.items.get(input.id);
    if (current) {
      this.items.set(input.id, { ...current, status: 'superseded', lastError: input.reason });
    }
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    const current = this.items.get(input.id);
    if (current?.attemptGeneration === input.attemptGeneration) {
      this.items.set(input.id, {
        ...current,
        status: input.retryable ? 'failed_retryable' : 'failed_terminal',
        lastError: input.error,
        ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
        updatedAt: input.nowIso,
      });
    }
  }

  async countRecentDelivered(input: { memberName: string; sinceIso: string }): Promise<number> {
    return [...this.items.values()].filter(
      (item) =>
        item.status === 'delivered' &&
        item.memberName === input.memberName &&
        item.updatedAt >= input.sinceIso
    ).length;
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    const requested = new Set(input.reviewRequestEventIds);
    return [
      ...new Set(
        [...this.items.values()]
          .filter(
            (item) =>
              item.memberName === input.memberName &&
              item.status === 'delivered' &&
              item.payload.workSyncIntent === 'review_pickup'
          )
          .flatMap((item) => item.payload.workSyncReviewRequestEventIds ?? [])
          .filter((eventId) => requested.has(eventId))
      ),
    ].sort();
  }
}

class InMemoryInboxNudge implements MemberWorkSyncInboxNudgePort {
  readonly inserted: Array<Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]> = [];
  fail = false;

  async insertIfAbsent(input: Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]) {
    if (this.fail) {
      throw new Error('inbox unavailable');
    }
    this.inserted.push(input);
    return { inserted: true, messageId: input.messageId };
  }
}

function createDeps(options?: {
  items?: MemberWorkSyncActionableWorkItem[];
  activeMemberNames?: string[];
  inactive?: boolean;
  teamActive?: boolean;
  providerId?: 'opencode' | 'codex';
  outboxStore?: MemberWorkSyncOutboxStorePort;
  inboxNudge?: MemberWorkSyncInboxNudgePort;
  busySignal?: MemberWorkSyncUseCaseDeps['busySignal'];
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort;
}) {
  const clock = new MutableClock();
  const store = new InMemoryStatusStore();
  const auditEvents: MemberWorkSyncAuditEvent[] = [];
  const source: MemberWorkSyncAgendaSourceResult = {
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      items: options?.items ?? [workItem],
      diagnostics: [],
    },
    activeMemberNames: options?.activeMemberNames ?? ['bob'],
    inactive: options?.inactive ?? false,
    ...(options?.providerId ? { providerId: options.providerId } : {}),
    diagnostics: [],
  };
  const deps: MemberWorkSyncUseCaseDeps = {
    clock,
    hash: {
      sha256Hex: (value) => `hash-${value.length}`,
    },
    agendaSource: {
      loadAgenda: async () => source,
    },
    statusStore: store,
    reportStore: store,
    ...(options?.outboxStore ? { outboxStore: options.outboxStore } : {}),
    ...(options?.inboxNudge ? { inboxNudge: options.inboxNudge } : {}),
    ...(options?.busySignal ? { busySignal: options.busySignal } : {}),
    ...(options?.reviewPickupDelivery
      ? { reviewPickupDelivery: options.reviewPickupDelivery }
      : {}),
    ...(options?.reviewPickupEscalation
      ? { reviewPickupEscalation: options.reviewPickupEscalation }
      : {}),
    reportToken: {
      create: async (input) => ({
        token: `token:${input.teamName}:${input.memberName}:${input.agendaFingerprint}`,
        expiresAt: '2026-04-29T00:15:00.000Z',
      }),
      verify: async (input) =>
        input.token === `token:${input.teamName}:${input.memberName}:${input.agendaFingerprint}`
          ? { ok: true }
          : { ok: false, reason: input.token ? 'invalid' : 'missing' },
    },
    lifecycle: {
      isTeamActive: () => options?.teamActive ?? true,
    },
    auditJournal: {
      append: async (event) => {
        auditEvents.push(event);
      },
    },
  };
  return { auditEvents, clock, deps, source, store };
}

describe('MemberWorkSync use cases', () => {
  it('reconciles actionable work into needs_sync without side effects', async () => {
    const { auditEvents, deps, store } = createDeps();
    const status = await new MemberWorkSyncReconciler(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
    });

    expect(status.state).toBe('needs_sync');
    expect(status.agenda.items).toEqual([workItem]);
    expect(status.diagnostics).toContain('no_current_report');
    expect(status.reportToken).toBe(`token:team-a:bob:${status.agenda.fingerprint}`);
    expect(status.shadow).toMatchObject({
      reconciledBy: 'request',
      wouldNudge: true,
      fingerprintChanged: false,
    });
    expect(store.pendingReports).toEqual([]);
    expect(auditEvents.map((event) => event.event)).toEqual([
      'reconcile_started',
      'agenda_loaded',
      'decision_made',
    ]);
  });

  it('accepts still_working as a bounded lease for the current fingerprint', async () => {
    const { auditEvents, clock, deps } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      taskIds: ['task-1'],
      leaseTtlMs: 120_000,
      source: 'test',
    });

    expect(result.accepted).toBe(true);
    expect(result.status.state).toBe('still_working');
    expect(result.status.shadow).toMatchObject({ reconciledBy: 'report', wouldNudge: false });

    clock.set('2026-04-29T00:01:59.000Z');
    expect((await reader.execute({ teamName: 'team-a', memberName: 'bob' })).state).toBe(
      'still_working'
    );

    clock.set('2026-04-29T00:02:00.000Z');
    const expired = await reader.execute({ teamName: 'team-a', memberName: 'bob' });
    expect(expired.state).toBe('needs_sync');
    expect(expired.diagnostics).toContain('report_lease_expired');
    expect(auditEvents.map((event) => event.event)).toContain('report_accepted');
  });

  it('uses app clock instead of model supplied reportedAt for lease timing', async () => {
    const { deps } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      reportedAt: '2099-01-01T00:00:00.000Z',
      leaseTtlMs: 120_000,
      source: 'test',
    });

    expect(result.accepted).toBe(true);
    expect(result.status.report?.reportedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(result.status.report?.expiresAt).toBe('2026-04-29T00:02:00.000Z');
  });

  it('uses a short still_working lease for review pickup reports', async () => {
    const { deps } = createDeps({ items: [reviewPickupItem] });
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      leaseTtlMs: 60 * 60 * 1000,
      source: 'test',
    });

    expect(result.accepted).toBe(true);
    expect(result.status.report?.expiresAt).toBe('2026-04-29T00:10:00.000Z');
  });

  it('rejects stale reports without turning app-side validation failures into pending intents', async () => {
    const { auditEvents, deps, store } = createDeps();
    const result = await new MemberWorkSyncReporter(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'caught_up',
      agendaFingerprint: 'agenda:v1:stale',
      source: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('stale_fingerprint');
    expect(result.status.state).toBe('needs_sync');
    expect(result.status.report).toMatchObject({
      accepted: false,
      rejectionCode: 'stale_fingerprint',
      agendaFingerprint: 'agenda:v1:stale',
    });
    expect(store.writes.at(-1)?.diagnostics).toContain('report_rejected:stale_fingerprint');
    expect(store.pendingReports).toHaveLength(0);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'report_rejected',
          reason: 'stale_fingerprint',
        }),
      ])
    );
  });

  it('accepts caught_up only when the app-side agenda is empty', async () => {
    const { deps } = createDeps({ items: [] });
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'caught_up',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      source: 'test',
    });

    expect(result.accepted).toBe(true);
    expect(result.status.state).toBe('caught_up');
  });

  it('marks status inactive when the team runtime is not active', async () => {
    const { deps } = createDeps({ teamActive: false });
    const status = await new MemberWorkSyncReconciler(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
    });

    expect(status.state).toBe('inactive');
    expect(status.diagnostics).toContain('team_runtime_inactive');
    expect(status.shadow?.wouldNudge).toBe(false);
  });

  it('records fingerprint transitions without treating them as progress proof', async () => {
    const { deps, source } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    source.agenda.items = [
      {
        ...workItem,
        taskId: 'task-2',
        displayId: '22222222',
        subject: 'New work',
      },
    ];
    const changed = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    expect(changed.shadow).toMatchObject({
      fingerprintChanged: true,
      wouldNudge: true,
    });
    expect(changed.shadow?.previousFingerprint).toMatch(/^agenda:v1:/);
    expect(changed.state).toBe('needs_sync');
  });

  it('does not create outbox nudges until shadow readiness is green', async () => {
    const outbox = new InMemoryOutboxStore();
    const { deps } = createDeps({ outboxStore: outbox });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toEqual([]);
  });

  it('creates review pickup outbox while shadow data is collecting only with delivery capability', async () => {
    const outbox = new InMemoryOutboxStore();
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async () => ({
        ok: true,
        state: 'prompt_accepted',
        messageId: 'unused',
      }),
    };
    const { deps } = createDeps({
      items: [reviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      reviewPickupDelivery,
    });

    const status = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]).toMatchObject({
      id: 'member-work-sync:team-a:bob:review-pickup:evt-review-request',
      agendaFingerprint: status.agenda.fingerprint,
      payload: {
        workSyncIntent: 'review_pickup',
        workSyncIntentKey: 'review-pickup:evt-review-request',
        workSyncReviewRequestEventIds: ['evt-review-request'],
      },
    });
  });

  it('creates one review pickup outbox for multiple current review requests', async () => {
    const outbox = new InMemoryOutboxStore();
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async () => ({
        ok: true,
        state: 'prompt_accepted',
        messageId: 'unused',
      }),
    };
    const { deps } = createDeps({
      items: [reviewPickupItem, secondReviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      reviewPickupDelivery,
    });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]).toMatchObject({
      id: 'member-work-sync:team-a:bob:review-pickup:evt-review-request+evt-review-request-b',
      payload: {
        workSyncIntent: 'review_pickup',
        workSyncIntentKey: 'review-pickup:evt-review-request+evt-review-request-b',
        workSyncReviewRequestEventIds: ['evt-review-request', 'evt-review-request-b'],
        taskRefs: [
          { taskId: 'task-review', displayId: '22222222', teamName: 'team-a' },
          { taskId: 'task-review-b', displayId: '33333333', teamName: 'team-a' },
        ],
      },
    });
  });

  it('filters already delivered review request ids before planning another pickup nudge', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async (input) => ({
        ok: true,
        state: 'prompt_accepted',
        messageId: input.messageId,
      }),
    };
    const { deps, source } = createDeps({
      items: [reviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      inboxNudge: inbox,
      reviewPickupDelivery,
    });
    const reconciler = new MemberWorkSyncReconciler(deps);

    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    source.agenda.items = [reviewPickupItem, secondReviewPickupItem];
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures.at(-1)).toMatchObject({
      id: 'member-work-sync:team-a:bob:review-pickup:evt-review-request-b',
      payload: {
        workSyncIntent: 'review_pickup',
        workSyncReviewRequestEventIds: ['evt-review-request-b'],
        taskRefs: [{ taskId: 'task-review-b', displayId: '33333333', teamName: 'team-a' }],
      },
    });
  });

  it('does not create review pickup outbox when delivery capability is unavailable', async () => {
    const outbox = new InMemoryOutboxStore();
    const escalations: Array<Parameters<MemberWorkSyncReviewPickupEscalationPort['escalate']>[0]> =
      [];
    const { auditEvents, deps } = createDeps({
      items: [reviewPickupItem],
      providerId: 'codex',
      outboxStore: outbox,
      reviewPickupEscalation: {
        escalate: async (input) => {
          escalations.push(input);
        },
      },
    });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toEqual([]);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'review_pickup_delivery_unavailable',
          reason: 'review_pickup_delivery_port_unavailable',
        }),
        expect.objectContaining({
          event: 'review_pickup_escalated',
          reason: 'review_pickup_delivery_port_unavailable',
        }),
        expect.objectContaining({
          event: 'nudge_skipped',
          reason: 'review_pickup_delivery_unavailable',
        }),
      ])
    );
    expect(escalations).toEqual([
      expect.objectContaining({
        teamName: 'team-a',
        memberName: 'bob',
        reason: 'review_pickup_delivery_port_unavailable',
        reviewRequestEventIds: ['evt-review-request'],
      }),
    ]);
  });

  it('does not create outbox nudges from read-only diagnostics requests', async () => {
    const outbox = new InMemoryOutboxStore();
    const { deps, store } = createDeps({ outboxStore: outbox });
    store.phase2ReadinessState = 'shadow_ready';

    await new MemberWorkSyncDiagnosticsReader(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
    });

    expect(outbox.ensures).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('plans a nudge from status refresh once readiness is green', async () => {
    const outbox = new InMemoryOutboxStore();
    const { deps, store } = createDeps({ outboxStore: outbox });
    store.phase2ReadinessState = 'shadow_ready';

    const status = await new MemberWorkSyncReconciler(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
    });

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]).toMatchObject({
      id: `member-work-sync:team-a:bob:${status.agenda.fingerprint}`,
      teamName: 'team-a',
      memberName: 'bob',
    });
  });

  it('creates one idempotent outbox nudge intent when Phase 2 readiness is green', async () => {
    const outbox = new InMemoryOutboxStore();
    const { deps, store } = createDeps({ outboxStore: outbox });
    store.phase2ReadinessState = 'shadow_ready';

    const status = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]).toMatchObject({
      id: `member-work-sync:team-a:bob:${status.agenda.fingerprint}`,
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: status.agenda.fingerprint,
      payload: {
        from: 'system',
        to: 'bob',
        messageKind: 'member_work_sync_nudge',
        source: 'member-work-sync',
        actionMode: 'do',
        taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
      },
    });
    const nudgeText = outbox.ensures[0]?.payload.text ?? '';
    expect(nudgeText).toContain(
      'member_work_sync_status with teamName "team-a" and memberName "bob"'
    );
    expect(nudgeText).toContain('member_work_sync_report with the same teamName/memberName');
    expect(nudgeText).toContain('mcp__agent-teams__member_work_sync_status');
    expect(nudgeText).toContain('taskIds: "task-1"');
    expect(nudgeText).toContain(
      'Do not use provider names, runtime names, or team names as memberName'
    );
  });

  it('dispatches due nudges only after revalidating current status and readiness', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { deps, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const status = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, superseded: 0 });
    expect(inbox.inserted).toHaveLength(1);
    expect(inbox.inserted[0]).toMatchObject({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: `member-work-sync:team-a:bob:${status.agenda.fingerprint}`,
    });
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${status.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'delivered',
      deliveredMessageId: `member-work-sync:team-a:bob:${status.agenda.fingerprint}`,
    });
  });

  it('creates a status-only recovery nudge after a delivered nudge turn settles without a report', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    let busyChecks = 0;
    const { deps, store } = createDeps({
      outboxStore: outbox,
      inboxNudge: inbox,
      busySignal: {
        isBusy: async () => {
          busyChecks += 1;
          return busyChecks > 1
            ? { busy: true, reason: 'recent_tool_activity' }
            : { busy: false };
        },
      },
    });
    store.phase2ReadinessState = 'shadow_ready';

    const firstStatus = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('status-only:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      payload: {
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: `status-only:${firstStatus.agenda.fingerprint}`,
      },
    });
    expect(recovery?.payload.text).toContain('previous work-sync turn appears to have stopped');

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, superseded: 0 });
    expect(busyChecks).toBe(2);
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('status-only');
  });

  it('creates an agenda-sync refresh recovery when a delivered nudge has a stale payload hash', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    outbox.rejectPayloadConflicts = true;
    const { auditEvents, deps, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const firstStatus = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    const baseId = `member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`;
    const delivered = outbox.items.get(baseId);
    expect(delivered).toMatchObject({ status: 'delivered' });
    outbox.items.set(baseId, {
      ...delivered!,
      payloadHash: 'legacy-payload-hash',
      payload: {
        ...delivered!.payload,
        text: 'Legacy delivered work-sync nudge text.',
      },
    });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-refresh:')
    );
    expect(recoveryItems).toHaveLength(1);
    expect(recoveryItems[0]).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      payload: {
        workSyncIntent: 'agenda_sync',
        taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
      },
    });
    expect(recoveryItems[0]?.id).toContain(firstStatus.agenda.fingerprint);
    expect(recoveryItems[0]?.payload.text).toContain('Work sync refresh');
    expect(recoveryItems[0]?.payload.text).toContain('current required sync action');
    expect(outbox.items.get(baseId)).toMatchObject({
      status: 'delivered',
      payloadHash: 'legacy-payload-hash',
    });
    expect(
      auditEvents.filter(
        (event) => event.event === 'nudge_skipped' && event.reason === 'payload_conflict'
      )
    ).toHaveLength(0);

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(
      [...outbox.items.values()].filter((item) =>
        item.payload.workSyncIntentKey?.startsWith('agenda-sync-refresh:')
      )
    ).toHaveLength(1);

    await expect(
      new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
        teamNames: ['team-a'],
        claimedBy: 'test-dispatcher',
      })
    ).resolves.toMatchObject({ claimed: 1, delivered: 1, superseded: 0 });

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    const statusOnlyItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('status-only:')
    );
    expect(statusOnlyItems).toHaveLength(1);
    expect(statusOnlyItems[0]?.payload.text).toContain('Status-only recovery');
  });

  it('marks review pickup delivered only after the delivery port confirms prompt acceptance', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const deliveryCalls: Array<Parameters<MemberWorkSyncReviewPickupDeliveryPort['deliver']>[0]> =
      [];
    const busyCalls: Parameters<
      NonNullable<MemberWorkSyncUseCaseDeps['busySignal']>['isBusy']
    >[0][] = [];
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async (input) => {
        deliveryCalls.push(input);
        return {
          ok: true,
          state: 'prompt_accepted',
          messageId: input.messageId,
          diagnostics: ['accepted_by_bridge'],
        };
      },
    };
    const { deps } = createDeps({
      items: [reviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      inboxNudge: inbox,
      reviewPickupDelivery,
      busySignal: {
        isBusy: (input) => {
          busyCalls.push(input);
          return Promise.resolve({ busy: false });
        },
      },
    });

    await new MemberWorkSyncReconciler(deps).execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, superseded: 0 });
    expect(inbox.inserted).toHaveLength(1);
    expect(busyCalls).toEqual([
      {
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:00.000Z',
        workSyncIntent: 'review_pickup',
        workSyncIntentKey: 'review-pickup:evt-review-request',
        taskRefs: [{ taskId: 'task-review', displayId: '22222222', teamName: 'team-a' }],
      },
    ]);
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]).toMatchObject({
      messageId: 'member-work-sync:team-a:bob:review-pickup:evt-review-request',
      inserted: true,
      providerId: 'opencode',
      payload: {
        workSyncIntent: 'review_pickup',
      },
    });
    expect(
      outbox.items.get('member-work-sync:team-a:bob:review-pickup:evt-review-request')
    ).toMatchObject({
      status: 'delivered',
      deliveryState: 'prompt_accepted',
      deliveryDiagnostics: ['accepted_by_bridge'],
    });
  });

  it('marks review pickup terminal when delivery reports terminal failure', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const escalations: Array<Parameters<MemberWorkSyncReviewPickupEscalationPort['escalate']>[0]> =
      [];
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async () => ({
        ok: false,
        reason: 'terminal_failure',
        message: 'empty_assistant_turn',
        diagnostics: ['empty_assistant_turn'],
      }),
    };
    const { auditEvents, deps } = createDeps({
      items: [reviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      inboxNudge: inbox,
      reviewPickupDelivery,
      reviewPickupEscalation: {
        escalate: async (input) => {
          escalations.push(input);
        },
      },
    });

    await new MemberWorkSyncReconciler(deps).execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, terminal: 1 });
    expect(inbox.inserted).toHaveLength(1);
    const item = outbox.items.get('member-work-sync:team-a:bob:review-pickup:evt-review-request');
    expect(item).toMatchObject({
      status: 'failed_terminal',
      lastError: 'empty_assistant_turn',
    });
    expect(item?.nextAttemptAt).toBeUndefined();

    await new MemberWorkSyncReconciler(deps).execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'review_pickup_escalated',
          reason: 'review_pickup_delivery_failed_still_stuck',
        }),
      ])
    );
    expect(escalations).toEqual([
      expect.objectContaining({
        reason: 'review_pickup_delivery_failed_still_stuck',
        reviewRequestEventIds: ['evt-review-request'],
      }),
    ]);
  });

  it('escalates instead of sending another review pickup nudge when the same request is still stuck after delivery', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const escalations: Array<Parameters<MemberWorkSyncReviewPickupEscalationPort['escalate']>[0]> =
      [];
    const reviewPickupDelivery: MemberWorkSyncReviewPickupDeliveryPort = {
      canDeliver: async () => ({ ok: true }),
      deliver: async (input) => ({
        ok: true,
        state: 'prompt_accepted',
        messageId: input.messageId,
      }),
    };
    const { auditEvents, deps } = createDeps({
      items: [reviewPickupItem],
      providerId: 'opencode',
      outboxStore: outbox,
      inboxNudge: inbox,
      reviewPickupDelivery,
      reviewPickupEscalation: {
        escalate: async (input) => {
          escalations.push(input);
        },
      },
    });

    const reconciler = new MemberWorkSyncReconciler(deps);
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(inbox.inserted).toHaveLength(1);
    expect(
      outbox.items.get('member-work-sync:team-a:bob:review-pickup:evt-review-request')
    ).toMatchObject({ status: 'delivered' });
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'review_pickup_escalated',
          reason: 'review_pickup_already_delivered_still_stuck',
        }),
        expect.objectContaining({
          event: 'nudge_skipped',
          reason: 'review_pickup_already_delivered_still_stuck',
        }),
      ])
    );
    expect(escalations).toEqual([
      expect.objectContaining({
        reason: 'review_pickup_already_delivered_still_stuck',
        reviewRequestEventIds: ['evt-review-request'],
      }),
    ]);
  });

  it('recomputes agenda before dispatch and supersedes stale outbox fingerprints', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { deps, source, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const status = await new MemberWorkSyncReconciler(deps).execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    source.agenda.items = [];

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, superseded: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${status.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'superseded',
      lastError: 'status_no_longer_matches_outbox',
    });
  });

  it('does not dispatch stale outbox items after the member reports still working', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      leaseTtlMs: 120_000,
      source: 'test',
    });

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, superseded: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'superseded',
      lastError: 'status_no_longer_matches_outbox',
    });

    clock.set('2026-04-29T00:03:00.000Z');
    const expired = await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(expired.state).toBe('needs_sync');
    const revived = outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`);
    expect(revived).toMatchObject({ status: 'pending' });
    expect(revived).not.toHaveProperty('lastError');
  });

  it('rate-limits delivered nudges per member per hour', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { deps, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const current = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const firstId = `member-work-sync:team-a:bob:${current.agenda.fingerprint}:old-1`;
    const secondId = `member-work-sync:team-a:bob:${current.agenda.fingerprint}:old-2`;
    const baseItem = outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`);
    expect(baseItem).toBeDefined();
    for (const id of [firstId, secondId]) {
      outbox.items.set(id, {
        ...(baseItem as NonNullable<typeof baseItem>),
        id,
        status: 'delivered',
        deliveredMessageId: id,
        updatedAt: '2026-04-29T00:00:00.000Z',
      });
    }

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, retryable: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'failed_retryable',
      lastError: 'member_nudge_rate_limited',
      nextAttemptAt: '2026-04-29T01:00:00.000Z',
    });
  });

  it('defers nudge dispatch while the member has active or recent tool activity', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { auditEvents, deps, store } = createDeps({
      outboxStore: outbox,
      inboxNudge: inbox,
      busySignal: {
        isBusy: async () => ({
          busy: true,
          reason: 'active_tool_activity',
          retryAfterIso: '2026-04-29T00:02:00.000Z',
        }),
      },
    });
    store.phase2ReadinessState = 'shadow_ready';

    const current = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['tool_finished'] }
    );
    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, retryable: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'failed_retryable',
      lastError: 'member_busy:active_tool_activity',
      nextAttemptAt: '2026-04-29T00:02:00.000Z',
    });
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'member_busy',
          reason: 'member_busy:active_tool_activity',
        }),
      ])
    );
  });

  it('uses bounded retry backoff when inbox delivery fails', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    inbox.fail = true;
    const { deps, store } = createDeps({ outboxStore: outbox, inboxNudge: inbox });
    store.phase2ReadinessState = 'shadow_ready';

    const current = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    const item = outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`);
    expect(summary).toMatchObject({ claimed: 1, delivered: 0, retryable: 1 });
    expect(item).toMatchObject({
      status: 'failed_retryable',
      lastError: 'Error: inbox unavailable',
    });
    expect(Date.parse(item?.nextAttemptAt ?? '')).toBeGreaterThan(
      Date.parse('2026-04-29T00:09:59.000Z')
    );
    expect(Date.parse(item?.nextAttemptAt ?? '')).toBeLessThanOrEqual(
      Date.parse('2026-04-29T00:14:00.000Z')
    );
  });

  it('rejects invalid report tokens without recording replayable intents', async () => {
    const { deps, store } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: 'token:team-a:alice:wrong',
      source: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('invalid_report_token');
    expect(result.status.report).toMatchObject({
      accepted: false,
      rejectionCode: 'invalid_report_token',
    });
    expect(store.pendingReports).toHaveLength(0);
  });

  it('replays pending controller intents through the same app validator', async () => {
    const { deps, store } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });
    store.pendingIntents.set('intent-1', {
      id: 'intent-1',
      teamName: 'team-a',
      memberName: 'bob',
      status: 'pending',
      reason: 'control_api_unavailable',
      recordedAt: '2026-04-29T00:00:01.000Z',
      request: {
        teamName: 'team-a',
        memberName: 'bob',
        state: 'still_working',
        agendaFingerprint: current.agenda.fingerprint,
        reportToken: current.reportToken,
        leaseTtlMs: 120_000,
        source: 'mcp',
      },
    });

    const summary = await new MemberWorkSyncPendingReportIntentReplayer(deps).replayTeam('team-a');

    expect(summary).toEqual({ processed: 1, accepted: 1, rejected: 0, superseded: 0 });
    expect(store.pendingIntents.get('intent-1')).toMatchObject({
      status: 'accepted',
      resultCode: 'accepted',
      processedAt: '2026-04-29T00:00:00.000Z',
    });
    expect(store.writes.at(-1)?.state).toBe('still_working');
  });
});
