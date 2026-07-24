import {
  MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC,
  MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX,
  MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC,
  MEMBER_WORK_SYNC_SUPPRESSION_RESET_DIAGNOSTIC,
  type MemberWorkSyncAgendaSourceResult,
  type MemberWorkSyncAuditEvent,
  MemberWorkSyncDiagnosticsReader,
  type MemberWorkSyncInboxNudgePort,
  MemberWorkSyncNudgeDispatcher,
  type MemberWorkSyncOutboxStorePort,
  MemberWorkSyncPendingReportIntentReplayer,
  MemberWorkSyncReconcileCancelledError,
  MemberWorkSyncReconciler,
  MemberWorkSyncReporter,
  type MemberWorkSyncReviewPickupDeliveryPort,
  type MemberWorkSyncReviewPickupEscalationPort,
  type MemberWorkSyncStatusStorePort,
  type MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberWorkSyncActionableWorkItem,
  MemberWorkSyncMetricEvent,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncPhase2ReadinessReason,
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

const inProgressWorkItem: MemberWorkSyncActionableWorkItem = {
  ...workItem,
  reason: 'owned_in_progress_task',
  evidence: {
    status: 'in_progress',
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

function isTerminalOutboxStatus(status: MemberWorkSyncOutboxItem['status']): boolean {
  return status === 'delivered' || status === 'superseded' || status === 'failed_terminal';
}

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
  phase2ReadinessReasons: MemberWorkSyncPhase2ReadinessReason[] = [];
  phase2WouldNudgesPerMemberHour = 0.5;
  phase2FingerprintChangesPerMemberHour = 0;
  phase2ReportRejectionRate = 0;
  metricsGeneratedAt = '2026-04-29T00:00:00.000Z';
  recentEvents: MemberWorkSyncMetricEvent[] = [];

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
      generatedAt: this.metricsGeneratedAt,
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
      recentEvents: this.recentEvents,
      phase2Readiness: {
        state: this.phase2ReadinessState,
        reasons: this.phase2ReadinessReasons,
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
          wouldNudgesPerMemberHour: this.phase2WouldNudgesPerMemberHour,
          fingerprintChangesPerMemberHour: this.phase2FingerprintChangesPerMemberHour,
          reportRejectionRate: this.phase2ReportRejectionRate,
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
    if (current?.attemptGeneration === input.attemptGeneration && current.status === 'claimed') {
      const next = {
        ...current,
        status: 'delivered' as const,
        deliveredMessageId: input.deliveredMessageId,
        ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
        ...(input.deliveryDiagnostics ? { deliveryDiagnostics: input.deliveryDiagnostics } : {}),
        updatedAt: input.nowIso,
      };
      delete next.nextAttemptAt;
      this.items.set(input.id, next);
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
    if (
      current?.attemptGeneration === input.attemptGeneration &&
      !isTerminalOutboxStatus(current.status)
    ) {
      this.items.set(input.id, {
        ...current,
        status: input.retryable ? 'failed_retryable' : 'failed_terminal',
        lastError: input.error,
        ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
        updatedAt: input.nowIso,
      });
    }
  }

  async countRecentDelivered(input: {
    memberName: string;
    sinceIso: string;
    workSyncIntentKeyPrefix?: string;
  }): Promise<number> {
    return [...this.items.values()].filter(
      (item) =>
        item.status === 'delivered' &&
        item.memberName === input.memberName &&
        item.updatedAt >= input.sinceIso &&
        (!input.workSyncIntentKeyPrefix ||
          item.payload.workSyncIntentKey?.startsWith(input.workSyncIntentKeyPrefix) === true)
    ).length;
  }

  async countDeliveredForAgenda(input: {
    memberName: string;
    agendaFingerprint: string;
    sinceIso?: string;
  }): Promise<number> {
    return [...this.items.values()].filter(
      (item) =>
        item.status === 'delivered' &&
        item.memberName === input.memberName &&
        item.agendaFingerprint === input.agendaFingerprint &&
        (!input.sinceIso || item.updatedAt > input.sinceIso)
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

function seedDeliveredAgendaNudges(
  outbox: InMemoryOutboxStore,
  baseItem: MemberWorkSyncOutboxItem,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    const timestamp = `2026-04-29T00:00:0${index}.000Z`;
    outbox.items.set(`${baseItem.id}:delivered:${index}`, {
      ...baseItem,
      id: `${baseItem.id}:delivered:${index}`,
      status: 'delivered',
      attemptGeneration: 1,
      deliveredMessageId: `${baseItem.id}:delivered-message:${index}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

class InMemoryInboxNudge implements MemberWorkSyncInboxNudgePort {
  readonly inserted: Array<Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]> = [];
  readonly repaired: Array<
    Parameters<NonNullable<MemberWorkSyncInboxNudgePort['repairIfPresent']>>[0]
  > = [];
  fail = false;
  conflict = false;
  repairFail = false;
  repairConflict = false;

  async insertIfAbsent(input: Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]) {
    if (this.fail) {
      throw new Error('inbox unavailable');
    }
    if (this.conflict) {
      return { inserted: false, messageId: input.messageId, conflict: true };
    }
    this.inserted.push(input);
    return { inserted: true, messageId: input.messageId };
  }

  async repairIfPresent(
    input: Parameters<NonNullable<MemberWorkSyncInboxNudgePort['repairIfPresent']>>[0]
  ) {
    if (this.repairFail) {
      throw new Error('inbox repair unavailable');
    }
    if (this.repairConflict) {
      return { found: true, repaired: false, conflict: true };
    }
    this.repaired.push(input);
    return { found: true, repaired: true };
  }
}

function createDeps(options?: {
  memberName?: string;
  items?: MemberWorkSyncActionableWorkItem[];
  activeMemberNames?: string[];
  inactive?: boolean;
  teamActive?: boolean;
  memberActive?: boolean;
  providerId?: 'opencode' | 'codex';
  outboxStore?: MemberWorkSyncOutboxStorePort;
  inboxNudge?: MemberWorkSyncInboxNudgePort;
  busySignal?: MemberWorkSyncUseCaseDeps['busySignal'];
  watchdogCooldown?: MemberWorkSyncUseCaseDeps['watchdogCooldown'];
  nudgeDeliveryWake?: MemberWorkSyncUseCaseDeps['nudgeDeliveryWake'];
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort;
}) {
  const clock = new MutableClock();
  const store = new InMemoryStatusStore();
  const auditEvents: MemberWorkSyncAuditEvent[] = [];
  const memberName = options?.memberName ?? 'bob';
  const source: MemberWorkSyncAgendaSourceResult = {
    agenda: {
      teamName: 'team-a',
      memberName,
      generatedAt: '2026-04-29T00:00:00.000Z',
      items: options?.items ?? [workItem],
      diagnostics: [],
    },
    activeMemberNames: options?.activeMemberNames ?? [memberName],
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
    ...(options?.watchdogCooldown ? { watchdogCooldown: options.watchdogCooldown } : {}),
    ...(options?.nudgeDeliveryWake ? { nudgeDeliveryWake: options.nudgeDeliveryWake } : {}),
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
      isMemberActive: () => options?.memberActive ?? true,
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

  it('does not write status or plan nudges after a queued reconcile is cancelled', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, deps, store } = createDeps({ outboxStore: outbox });

    await expect(
      new MemberWorkSyncReconciler(deps).execute(
        { teamName: 'team-a', memberName: 'bob' },
        {
          reconciledBy: 'queue',
          triggerReasons: ['turn_settled'],
          isCancelled: () => true,
        }
      )
    ).rejects.toBeInstanceOf(MemberWorkSyncReconcileCancelledError);

    expect(store.writes).toHaveLength(0);
    expect(outbox.ensures).toHaveLength(0);
    expect(auditEvents.map((event) => event.event)).toEqual(['reconcile_started']);
  });

  it('does not create a report token when a queued reconcile is cancelled after decision audit', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, deps, store } = createDeps({ outboxStore: outbox });
    let cancelled = false;
    let tokenCreates = 0;
    deps.auditJournal = {
      append: async (event) => {
        auditEvents.push(event);
        if (event.event === 'decision_made') {
          cancelled = true;
        }
      },
    };
    deps.reportToken = {
      create: async (input) => {
        tokenCreates += 1;
        return {
          token: `token:${input.teamName}:${input.memberName}:${input.agendaFingerprint}`,
          expiresAt: '2026-04-29T00:15:00.000Z',
        };
      },
      verify: async () => ({ ok: false, reason: 'missing' }),
    };

    await expect(
      new MemberWorkSyncReconciler(deps).execute(
        { teamName: 'team-a', memberName: 'bob' },
        {
          reconciledBy: 'queue',
          triggerReasons: ['turn_settled'],
          isCancelled: () => cancelled,
        }
      )
    ).rejects.toBeInstanceOf(MemberWorkSyncReconcileCancelledError);

    expect(tokenCreates).toBe(0);
    expect(store.writes).toHaveLength(0);
    expect(outbox.ensures).toHaveLength(0);
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

  it('rejects reports when this member runtime is no longer active', async () => {
    const { deps } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });
    const reporter = new MemberWorkSyncReporter({
      ...deps,
      lifecycle: {
        isTeamActive: () => true,
        isMemberActive: () => false,
      },
    });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      source: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('member_runtime_inactive');
    expect(result.status.state).toBe('inactive');
    expect(result.status.report).toMatchObject({
      accepted: false,
      rejectionCode: 'member_runtime_inactive',
    });
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

  it('rejects still_working on an empty agenda without recording a working status', async () => {
    const { deps, store } = createDeps({ items: [] });
    const reader = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });

    const result = await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: current.agenda.fingerprint,
      reportToken: current.reportToken,
      source: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('still_working_rejected_agenda_empty');
    expect(result.status.state).toBe('caught_up');
    expect(store.writes.at(-1)).toMatchObject({
      state: 'caught_up',
      report: {
        accepted: false,
        rejectionCode: 'still_working_rejected_agenda_empty',
      },
    });
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

  it('marks status inactive when this member runtime is not active', async () => {
    const { deps } = createDeps({ memberActive: false });
    const status = await new MemberWorkSyncReconciler(deps).execute({
      teamName: 'team-a',
      memberName: 'bob',
    });

    expect(status.state).toBe('inactive');
    expect(status.diagnostics).toContain('member_runtime_inactive');
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

  it('plans regular Codex recovery before turn-settled repair when only would-nudge telemetry is noisy', async () => {
    const outbox = new InMemoryOutboxStore();
    const { deps, store } = createDeps({
      providerId: 'codex',
      items: [inProgressWorkItem],
      outboxStore: outbox,
    });
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]?.payload).toMatchObject({
      workSyncIntent: 'agenda_sync',
    });
    expect(outbox.ensures[0]?.payload.workSyncIntentKey).toBeUndefined();
  });

  it('records exact readiness metrics when report rejection blocks planning', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, deps, store } = createDeps({
      providerId: 'codex',
      items: [inProgressWorkItem],
      outboxStore: outbox,
    });
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['report_rejection_rate_high'];
    store.phase2ReportRejectionRate = 0.75;

    await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );

    expect(outbox.ensures).toEqual([]);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        event: 'nudge_skipped',
        reason: 'blocking_metrics',
        diagnostics: [],
        metadata: expect.objectContaining({
          phase2ReadinessState: 'blocked',
          phase2ReadinessReasons: 'report_rejection_rate_high',
          reportRejectionRate: 0.75,
          maxReportRejectionRate: 0.2,
        }),
      })
    );
  });

  it('delivers Codex task protocol repair after a settled worker turn despite noisy metrics', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { auditEvents, deps, store } = createDeps({
      providerId: 'codex',
      items: [inProgressWorkItem],
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['report_rejection_rate_high'];
    const reconciler = new MemberWorkSyncReconciler(deps);

    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    expect(outbox.ensures).toHaveLength(1);
    expect(outbox.ensures[0]).toMatchObject({
      payload: {
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: expect.stringContaining('task-protocol-repair:'),
        taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName: 'team-a' }],
      },
    });
    expect(outbox.ensures[0]?.payload.text).toContain('Task protocol repair');
    expect(outbox.ensures[0]?.payload.text).toContain('task_add_comment');
    expect(outbox.ensures[0]?.payload.text).toContain('task_complete');

    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(inbox.inserted).toHaveLength(1);
    expect(inbox.inserted[0]?.payload.workSyncIntentKey).toContain('task-protocol-repair:');
    expect([...outbox.items.values()]).toEqual([
      expect.objectContaining({
        status: 'delivered',
        deliveredMessageId: inbox.inserted[0]?.messageId,
      }),
    ]);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'runtime_stall_observed',
          reason: 'same_agenda_still_needs_sync_after_turn_settled',
        }),
        expect.objectContaining({
          event: 'nudge_planned',
          reason: 'created',
        }),
        expect.objectContaining({
          event: 'nudge_delivered',
          reason: 'inbox_inserted',
        }),
      ])
    );
  });

  it('rate-limits repeated Codex task protocol repair deliveries', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, deps, store } = createDeps({
      providerId: 'codex',
      items: [inProgressWorkItem],
      outboxStore: outbox,
    });
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['report_rejection_rate_high'];
    const deliveredPayload = {
      from: 'system' as const,
      to: 'bob',
      messageKind: 'member_work_sync_nudge' as const,
      source: 'member-work-sync' as const,
      actionMode: 'do' as const,
      workSyncIntent: 'agenda_sync' as const,
      workSyncIntentKey: 'task-protocol-repair:old-agenda:task-1',
      text: 'Task protocol repair',
      taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName: 'team-a' }],
    };
    for (let index = 0; index < 2; index += 1) {
      outbox.items.set(`delivered-repair-${index}`, {
        id: `delivered-repair-${index}`,
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: `agenda:v1:old-${index}`,
        payloadHash: `hash-delivered-${index}`,
        payload: {
          ...deliveredPayload,
          workSyncIntentKey: `task-protocol-repair:old-agenda-${index}:task-1`,
        },
        status: 'delivered',
        attemptGeneration: 1,
        deliveredMessageId: `message-${index}`,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      });
    }
    const reconciler = new MemberWorkSyncReconciler(deps);

    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    expect(outbox.ensures).toEqual([]);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'nudge_skipped',
          reason: 'task_protocol_repair_rate_limited',
        }),
      ])
    );
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

  it('supersedes due nudges for inactive member runtimes without inbox delivery', async () => {
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
    const dispatcher = new MemberWorkSyncNudgeDispatcher({
      ...deps,
      lifecycle: {
        isTeamActive: () => true,
        isMemberActive: () => false,
      },
    });

    const summary = await dispatcher.dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, superseded: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${status.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'superseded',
      lastError: 'member_runtime_inactive',
    });
  });

  it('continues dispatching later claimed nudges when one item times out', async () => {
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
    const firstItem = [...outbox.items.values()][0];
    expect(firstItem).toBeDefined();
    await outbox.ensurePending({
      id: `${firstItem!.id}:second`,
      teamName: firstItem!.teamName,
      memberName: firstItem!.memberName,
      agendaFingerprint: firstItem!.agendaFingerprint,
      payloadHash: `${firstItem!.payloadHash}:second`,
      payload: {
        ...firstItem!.payload,
        workSyncIntentKey: 'test-second',
      },
      nowIso: status.evaluatedAt,
    });

    const inserted: Array<Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]> = [];
    const inbox: MemberWorkSyncInboxNudgePort = {
      insertIfAbsent: async (input) => {
        if (input.messageId === firstItem!.id) {
          return new Promise(() => undefined);
        }
        inserted.push(input);
        return { inserted: true, messageId: input.messageId };
      },
    };
    const dispatcher = new MemberWorkSyncNudgeDispatcher({
      ...deps,
      inboxNudge: inbox,
    });

    await expect(
      dispatcher.dispatchDue({
        teamNames: ['team-a'],
        claimedBy: 'test-dispatcher',
        itemTimeoutMs: 1,
      })
    ).resolves.toMatchObject({
      claimed: 2,
      delivered: 1,
      retryable: 1,
    });

    expect(outbox.items.get(firstItem!.id)).toMatchObject({
      status: 'failed_retryable',
      lastError: 'nudge dispatch item timed out after 1ms',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.messageId).toBe(`${firstItem!.id}:second`);
    expect(outbox.items.get(`${firstItem!.id}:second`)).toMatchObject({
      status: 'delivered',
    });
  });

  it('does not late-deliver an item after item dispatch timeout resolves', async () => {
    vi.useFakeTimers();
    try {
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
      const firstItem = [...outbox.items.values()][0];
      expect(firstItem).toBeDefined();

      let resolveInsertStarted!: () => void;
      const insertStarted = new Promise<void>((resolve) => {
        resolveInsertStarted = resolve;
      });
      let resolveInsert!: (value: { inserted: boolean; messageId: string }) => void;
      const insertResult = new Promise<{ inserted: boolean; messageId: string }>((resolve) => {
        resolveInsert = resolve;
      });
      const inbox: MemberWorkSyncInboxNudgePort = {
        insertIfAbsent: async () => {
          resolveInsertStarted();
          return insertResult;
        },
      };

      const dispatch = new MemberWorkSyncNudgeDispatcher({
        ...deps,
        inboxNudge: inbox,
      }).dispatchDue({
        teamNames: ['team-a'],
        claimedBy: 'test-dispatcher',
        itemTimeoutMs: 5,
        teamTimeoutMs: 100,
      });
      await insertStarted;
      await vi.advanceTimersByTimeAsync(5);

      await expect(dispatch).resolves.toMatchObject({
        claimed: 1,
        delivered: 0,
        retryable: 1,
      });
      expect(outbox.items.get(firstItem!.id)).toMatchObject({
        status: 'failed_retryable',
        lastError: 'nudge dispatch item timed out after 5ms',
      });

      resolveInsert({ inserted: true, messageId: firstItem!.id });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      expect(
        outbox.items.get(`member-work-sync:team-a:bob:${status.agenda.fingerprint}`)
      ).toMatchObject({
        status: 'failed_retryable',
        lastError: 'nudge dispatch item timed out after 5ms',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues dispatching later claimed nudges when retry marking also hangs', async () => {
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
    const firstItem = [...outbox.items.values()][0];
    expect(firstItem).toBeDefined();
    await outbox.ensurePending({
      id: `${firstItem!.id}:second`,
      teamName: firstItem!.teamName,
      memberName: firstItem!.memberName,
      agendaFingerprint: firstItem!.agendaFingerprint,
      payloadHash: `${firstItem!.payloadHash}:second`,
      payload: {
        ...firstItem!.payload,
        workSyncIntentKey: 'test-second',
      },
      nowIso: status.evaluatedAt,
    });

    const originalMarkFailed = outbox.markFailed.bind(outbox);
    outbox.markFailed = async (input) => {
      if (input.id === firstItem!.id) {
        return new Promise(() => undefined);
      }
      return originalMarkFailed(input);
    };
    const inserted: Array<Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]> = [];
    const inbox: MemberWorkSyncInboxNudgePort = {
      insertIfAbsent: async (input) => {
        if (input.messageId === firstItem!.id) {
          return new Promise(() => undefined);
        }
        inserted.push(input);
        return { inserted: true, messageId: input.messageId };
      },
    };
    const dispatcher = new MemberWorkSyncNudgeDispatcher({
      ...deps,
      inboxNudge: inbox,
    });

    await expect(
      dispatcher.dispatchDue({
        teamNames: ['team-a'],
        claimedBy: 'test-dispatcher',
        itemTimeoutMs: 1,
      })
    ).resolves.toMatchObject({
      claimed: 2,
      delivered: 1,
      retryable: 1,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.messageId).toBe(`${firstItem!.id}:second`);
    expect(outbox.items.get(`${firstItem!.id}:second`)).toMatchObject({
      status: 'delivered',
    });
  });

  it('continues checking other teams when one team outbox claim hangs', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const claimDue = vi.fn(
        async (input: Parameters<MemberWorkSyncOutboxStorePort['claimDue']>[0]) => {
          if (input.teamName === 'stuck') {
            await new Promise<void>(() => undefined);
          }
          return [];
        }
      );
      const inbox = new InMemoryInboxNudge();
      const { deps } = createDeps({
        outboxStore: { claimDue } as unknown as MemberWorkSyncOutboxStorePort,
        inboxNudge: inbox,
      });
      deps.logger = {
        debug: vi.fn(),
        warn,
        error: vi.fn(),
      };

      const dispatch = new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
        teamNames: ['stuck', 'healthy'],
        claimedBy: 'test-dispatcher',
        claimTimeoutMs: 10,
        teamTimeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(10);

      await expect(dispatch).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(claimDue).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'healthy',
        })
      );
      expect(warn).toHaveBeenCalledWith(
        'member work sync nudge claim timed out',
        expect.objectContaining({
          teamName: 'stuck',
          timeoutMs: 10,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mutate timed-out team items after team dispatch returns', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
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
      const firstItem = [...outbox.items.values()][0];
      expect(firstItem).toBeDefined();

      let resolveInsertStarted!: () => void;
      const insertStarted = new Promise<void>((resolve) => {
        resolveInsertStarted = resolve;
      });
      let resolveInsert!: (value: { inserted: boolean; messageId: string }) => void;
      const insertResult = new Promise<{ inserted: boolean; messageId: string }>((resolve) => {
        resolveInsert = resolve;
      });
      const inbox: MemberWorkSyncInboxNudgePort = {
        insertIfAbsent: async () => {
          resolveInsertStarted();
          return insertResult;
        },
      };
      deps.logger = {
        debug: vi.fn(),
        warn,
        error: vi.fn(),
      };

      const dispatch = new MemberWorkSyncNudgeDispatcher({
        ...deps,
        inboxNudge: inbox,
      }).dispatchDue({
        teamNames: ['team-a'],
        claimedBy: 'test-dispatcher',
        itemTimeoutMs: 100,
        teamTimeoutMs: 5,
      });
      await insertStarted;
      await vi.advanceTimersByTimeAsync(5);

      await expect(dispatch).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      });
      expect(outbox.items.get(firstItem!.id)).toMatchObject({
        status: 'claimed',
      });
      expect(warn).toHaveBeenCalledWith(
        'member work sync team nudge dispatch timed out',
        expect.objectContaining({
          teamName: 'team-a',
          timeoutMs: 5,
        })
      );

      resolveInsert({ inserted: true, messageId: firstItem!.id });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      expect(
        outbox.items.get(`member-work-sync:team-a:bob:${status.agenda.fingerprint}`)
      ).toMatchObject({
        status: 'claimed',
      });
    } finally {
      vi.useRealTimers();
    }
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
          return busyChecks > 1 ? { busy: true, reason: 'recent_tool_activity' } : { busy: false };
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

  it('records runtime-stall diagnostics when a settled turn leaves the same agenda needing sync', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, deps, store } = createDeps({
      providerId: 'opencode',
      outboxStore: outbox,
    });
    store.phase2ReadinessState = 'shadow_ready';
    const reconciler = new MemberWorkSyncReconciler(deps);

    const firstStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const stalledStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    expect(stalledStatus.agenda.fingerprint).toBe(firstStatus.agenda.fingerprint);
    expect(stalledStatus.diagnostics).toEqual(
      expect.arrayContaining([
        MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC,
        `${MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX}turn_settled`,
      ])
    );
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'runtime_stall_observed',
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: firstStatus.agenda.fingerprint,
          reason: 'same_agenda_still_needs_sync_after_turn_settled',
          diagnostics: expect.arrayContaining([MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC]),
        }),
      ])
    );
  });

  it('creates a delivered-still-stuck recovery after a delivered status-only nudge gets no report', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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

    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('status-only');

    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    const stillStuck = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(stillStuck).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
    expect(inbox.inserted[2]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('creates a still-stuck recovery when a terminal inbox conflict blocks a status-only nudge', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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

    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    inbox.conflict = true;
    const terminalSummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    const statusOnly = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('status-only:')
    );
    expect(terminalSummary).toMatchObject({ claimed: 1, delivered: 0, terminal: 1 });
    expect(statusOnly).toMatchObject({
      status: 'failed_terminal',
      lastError: 'inbox_payload_conflict',
    });

    inbox.conflict = false;
    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    const stillStuck = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(stillStuck).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const recoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(recoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('agenda-sync-still-stuck');

    clock.set('2026-04-29T01:02:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T01:02:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'team-lead',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recoveryItems).toHaveLength(2);
    expect(new Set(recoveryItems.map((item) => item.id)).size).toBe(2);

    const secondRecoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(secondRecoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
    expect(inbox.inserted[2]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('suppresses new work-sync nudges after repeated deliveries without an accepted report', async () => {
    const outbox = new InMemoryOutboxStore();
    const { auditEvents, clock, deps, source, store } = createDeps({ outboxStore: outbox });
    store.phase2ReadinessState = 'shadow_ready';
    const reconciler = new MemberWorkSyncReconciler(deps);

    const firstStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const baseId = `member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`;
    const baseItem = outbox.items.get(baseId);
    expect(baseItem).toBeDefined();
    seedDeliveredAgendaNudges(outbox, baseItem!, 4);
    const ensuresBefore = outbox.ensures.length;

    const suppressed = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['turn_settled'] }
    );

    expect(suppressed.diagnostics).toContain(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
    expect(suppressed.shadow?.wouldNudge).toBe(false);
    expect(suppressed.shadow?.nudgeSuppression).toMatchObject({
      reason: 'no_accepted_report',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      deliveredCount: 4,
    });
    expect(outbox.ensures).toHaveLength(ensuresBefore);
    expect(auditEvents.some((event) => event.event === 'nudge_suppressed')).toBe(true);

    const forced = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
        forceNudge: true,
      },
      { reconciledBy: 'request', triggerReasons: ['manual_refresh'] }
    );

    expect(forced.diagnostics).toContain(MEMBER_WORK_SYNC_SUPPRESSION_RESET_DIAGNOSTIC);
    expect(forced.diagnostics).not.toContain(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
    expect(forced.shadow?.wouldNudge).toBe(true);
    expect(forced.shadow?.nudgeSuppressionResetAt).toBe(forced.evaluatedAt);

    source.agenda.items = [
      {
        ...workItem,
        taskId: 'task-2-with-new-fingerprint',
        displayId: '22222222',
        subject: 'Ship a different sync agenda',
      },
    ];
    clock.set('2026-04-29T00:05:00.000Z');
    const changedFingerprint = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    expect(changedFingerprint.diagnostics).not.toContain(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
    expect(changedFingerprint.shadow?.wouldNudge).toBe(true);
    expect(changedFingerprint.shadow?.nudgeSuppressionResetAt).toBe(changedFingerprint.evaluatedAt);

    source.agenda.items = [workItem];
    clock.set('2026-04-29T00:06:00.000Z');
    const returnedFingerprint = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    expect(returnedFingerprint.agenda.fingerprint).toBe(firstStatus.agenda.fingerprint);
    expect(returnedFingerprint.diagnostics).not.toContain(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
    expect(returnedFingerprint.shadow?.wouldNudge).toBe(true);
    expect(returnedFingerprint.shadow?.nudgeSuppressionResetAt).toBe(
      returnedFingerprint.evaluatedAt
    );
  });

  it('supersedes pending nudges at dispatch when repeated deliveries are suppressed', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const scheduleWake = vi.fn(async () => undefined);
    const { deps, store } = createDeps({
      outboxStore: outbox,
      inboxNudge: inbox,
      nudgeDeliveryWake: { schedule: scheduleWake },
    });
    store.phase2ReadinessState = 'shadow_ready';

    const firstStatus = await new MemberWorkSyncReconciler(deps).execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const baseId = `member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`;
    const baseItem = outbox.items.get(baseId);
    expect(baseItem).toBeDefined();
    seedDeliveredAgendaNudges(outbox, baseItem!, 4);

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, superseded: 1 });
    expect(inbox.inserted).toHaveLength(0);
    expect(scheduleWake).not.toHaveBeenCalled();
    expect(outbox.items.get(baseId)).toMatchObject({
      status: 'superseded',
      lastError: MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC,
    });
    expect(store.writes.at(-1)?.diagnostics).toContain(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
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

  it('creates a delivered-still-stuck recovery after a delivered refresh nudge gets no report', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    outbox.rejectPayloadConflicts = true;
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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

    await reconciler.execute(
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

    expect(
      [...outbox.items.values()].filter((item) =>
        item.payload.workSyncIntentKey?.startsWith('agenda-sync-refresh:')
      )
    ).toHaveLength(1);
    expect(inbox.inserted).toHaveLength(2);

    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const stillStuck = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(stillStuck).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
    expect(inbox.inserted[2]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('creates a delivered-still-stuck recovery when a delivered agenda nudge gets no report', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    clock.set('2026-04-29T00:10:00.000Z');
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    store.recentEvents = [
      {
        id: 'stale-current-needs-sync',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'status_evaluated',
        state: 'needs_sync',
        agendaFingerprint: firstStatus.agenda.fingerprint,
        recordedAt: '2026-04-29T00:02:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
    ];

    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      payload: {
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: expect.stringContaining(
          `agenda-sync-still-stuck:${firstStatus.agenda.fingerprint}:`
        ),
      },
    });
    expect(recovery?.payload.text).toContain('still no accepted member_work_sync_report');
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('agenda-sync-still-stuck');

    clock.set('2026-04-29T00:20:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:20:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    expect(
      [...outbox.items.values()].filter((item) =>
        item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
      )
    ).toHaveLength(1);
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: baseId,
          payloadHash: outbox.items.get(baseId)?.payloadHash,
        }),
        expect.objectContaining({
          messageId: recovery?.id,
          payloadHash: recovery?.payloadHash,
        }),
      ])
    );

    clock.set('2026-04-29T01:02:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T01:02:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recoveryItems).toHaveLength(2);
    expect(new Set(recoveryItems.map((item) => item.id)).size).toBe(2);

    const secondSummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(secondSummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
  });

  it('does not accumulate still-stuck recovery buckets while tool approval is pending', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    let pendingApproval = false;
    const { auditEvents, clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
      busySignal: {
        isBusy: async () =>
          pendingApproval
            ? {
                busy: true,
                reason: 'pending_tool_approval',
                retryAfterIso: '2026-04-29T01:11:00.000Z',
              }
            : { busy: false },
      },
    });
    store.phase2ReadinessState = 'shadow_ready';
    const reconciler = new MemberWorkSyncReconciler(deps);
    const dispatcher = new MemberWorkSyncNudgeDispatcher(deps);

    const firstStatus = await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    await dispatcher.dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`)
    ).toMatchObject({ status: 'delivered' });

    pendingApproval = true;
    for (const iso of [
      '2026-04-29T00:10:00.000Z',
      '2026-04-29T00:40:00.000Z',
      '2026-04-29T01:10:00.000Z',
    ]) {
      clock.set(iso);
      store.metricsGeneratedAt = iso;
      await reconciler.execute(
        { teamName: 'team-a', memberName: 'bob' },
        { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
      );
    }

    expect(
      [...outbox.items.values()].filter((item) =>
        item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
      )
    ).toEqual([]);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        event: 'nudge_skipped',
        reason: 'member_busy',
        memberName: 'bob',
      })
    );

    pendingApproval = false;
    clock.set('2026-04-29T01:11:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T01:11:00.000Z';
    await reconciler.execute(
      { teamName: 'team-a', memberName: 'bob' },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recoveryItems).toHaveLength(1);
    expect(recoveryItems[0]).toMatchObject({ status: 'pending' });

    await dispatcher.dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(recoveryItems[0]?.id).toBe(inbox.inserted[1]?.messageId);
    expect(inbox.inserted).toHaveLength(2);
  });

  it('creates a delivered-still-stuck recovery after an accepted still_working lease expires', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const reporter = new MemberWorkSyncReporter(deps);
    const firstStatus = await reconciler.execute(
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
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    await reporter.execute({
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      reportToken: firstStatus.reportToken,
      taskIds: ['task-1'],
      leaseTtlMs: 120_000,
      source: 'test',
    });

    clock.set('2026-04-29T00:10:00.000Z');
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    store.recentEvents = [
      {
        id: 'old-report-accepted',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'report_accepted',
        state: 'still_working',
        agendaFingerprint: firstStatus.agenda.fingerprint,
        recordedAt: '2026-04-29T00:01:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
      {
        id: 'needs-sync-after-lease-expired',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'status_evaluated',
        state: 'needs_sync',
        agendaFingerprint: firstStatus.agenda.fingerprint,
        recordedAt: '2026-04-29T00:04:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
    ];

    const expiredStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    expect(expiredStatus).toMatchObject({
      state: 'needs_sync',
      diagnostics: expect.arrayContaining(['report_lease_expired']),
    });
    expect(expiredStatus.report).toBeUndefined();
    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('agenda-sync-still-stuck');

    clock.set('2026-04-29T01:02:00.000Z');
    store.phase2ReadinessState = 'shadow_ready';
    store.phase2ReadinessReasons = [];
    store.metricsGeneratedAt = '2026-04-29T01:02:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['config_changed', 'task_changed'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recoveryItems).toHaveLength(2);
    expect(new Set(recoveryItems.map((item) => item.id)).size).toBe(2);

    const secondSummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(secondSummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
    expect(inbox.inserted[2]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('creates a delivered-still-stuck recovery for mixed review pickup and native work under noisy metrics', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const inProgressItem: MemberWorkSyncActionableWorkItem = {
      ...workItem,
      reason: 'owned_in_progress_task',
      evidence: {
        status: 'in_progress',
        owner: 'bob',
      },
    };
    const { clock, deps, store } = createDeps({
      items: [reviewPickupItem, inProgressItem],
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    clock.set('2026-04-29T00:10:00.000Z');
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    store.recentEvents = [
      {
        id: 'mixed-needs-sync-stable',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'status_evaluated',
        state: 'needs_sync',
        agendaFingerprint: firstStatus.agenda.fingerprint,
        recordedAt: '2026-04-29T00:02:00.000Z',
        actionableCount: 2,
        providerId: 'codex',
      },
    ];

    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });
    expect(recovery?.payload.text).toContain('still no accepted member_work_sync_report');

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('records an existing delivered agenda nudge as skipped before still-stuck recovery age', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { auditEvents, clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
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
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    clock.set('2026-04-29T00:04:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:04:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    expect(
      [...outbox.items.values()].filter((item) =>
        item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
      )
    ).toHaveLength(0);
    expect(inbox.inserted).toHaveLength(1);
    expect(inbox.repaired).toEqual([
      expect.objectContaining({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: baseId,
        payloadHash: outbox.items.get(baseId)?.payloadHash,
      }),
    ]);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'nudge_skipped',
          reason: 'existing',
        }),
      ])
    );
  });

  it('creates a delivered-still-stuck recovery for a targeted lead despite noisy metrics', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const leadWorkItem: MemberWorkSyncActionableWorkItem = {
      ...workItem,
      assignee: 'team-lead',
      evidence: {
        status: 'pending',
        owner: 'team-lead',
      },
    };
    const { clock, deps, store } = createDeps({
      memberName: 'team-lead',
      items: [leadWorkItem],
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'team-lead',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    const baseId = `member-work-sync:team-a:team-lead:${firstStatus.agenda.fingerprint}`;
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'delivered' });

    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'team-lead',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      memberName: 'team-lead',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const recoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(recoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(2);
    expect(inbox.inserted[1]?.messageId).toContain('agenda-sync-still-stuck');

    clock.set('2026-04-29T01:02:00.000Z');
    store.phase2ReadinessState = 'shadow_ready';
    store.phase2ReadinessReasons = [];
    store.metricsGeneratedAt = '2026-04-29T01:02:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'team-lead',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recoveryItems = [...outbox.items.values()].filter((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recoveryItems).toHaveLength(2);
    expect(new Set(recoveryItems.map((item) => item.id)).size).toBe(2);

    const secondRecoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(secondRecoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(3);
    expect(inbox.inserted[2]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('creates a still-stuck recovery when a terminal inbox conflict blocks an agenda nudge', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const baseId = `member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`;
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'pending' });

    inbox.conflict = true;
    const terminalSummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(terminalSummary).toMatchObject({ claimed: 1, delivered: 0, terminal: 1 });
    expect(outbox.items.get(baseId)).toMatchObject({
      status: 'failed_terminal',
      lastError: 'inbox_payload_conflict',
    });

    inbox.conflict = false;
    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
      payload: {
        workSyncIntent: 'agenda_sync',
        workSyncIntentKey: expect.stringContaining(
          `agenda-sync-still-stuck:${firstStatus.agenda.fingerprint}:`
        ),
      },
    });
    expect(recovery?.payload.text).toContain('still no accepted member_work_sync_report');
    expect(outbox.items.get(baseId)).toMatchObject({ status: 'failed_terminal' });

    const recoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(recoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(1);
    expect(inbox.inserted[0]?.messageId).toContain('agenda-sync-still-stuck');
  });

  it('creates a still-stuck recovery when a terminal inbox conflict has a stale payload hash', async () => {
    const outbox = new InMemoryOutboxStore();
    outbox.rejectPayloadConflicts = true;
    const inbox = new InMemoryInboxNudge();
    const { clock, deps, store } = createDeps({
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
    store.phase2ReadinessState = 'shadow_ready';

    const reconciler = new MemberWorkSyncReconciler(deps);
    const firstStatus = await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['task_changed'] }
    );
    const baseId = `member-work-sync:team-a:bob:${firstStatus.agenda.fingerprint}`;

    inbox.conflict = true;
    await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    const terminal = outbox.items.get(baseId);
    expect(terminal).toMatchObject({
      status: 'failed_terminal',
      lastError: 'inbox_payload_conflict',
    });
    outbox.items.set(baseId, {
      ...terminal!,
      payloadHash: 'stale-terminal-payload-hash',
    });

    inbox.conflict = false;
    clock.set('2026-04-29T00:10:00.000Z');
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    await reconciler.execute(
      {
        teamName: 'team-a',
        memberName: 'bob',
      },
      { reconciledBy: 'queue', triggerReasons: ['manual_refresh'] }
    );

    const recovery = [...outbox.items.values()].find((item) =>
      item.payload.workSyncIntentKey?.startsWith('agenda-sync-still-stuck:')
    );
    expect(recovery).toMatchObject({
      status: 'pending',
      agendaFingerprint: firstStatus.agenda.fingerprint,
    });

    const recoverySummary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(recoverySummary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(1);
    expect(inbox.inserted[0]?.messageId).toContain('agenda-sync-still-stuck');
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

  it('dispatches native stale recovery after an attached still_working report expires', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const inProgressItem: MemberWorkSyncActionableWorkItem = {
      ...workItem,
      reason: 'owned_in_progress_task',
      evidence: {
        status: 'in_progress',
        owner: 'bob',
      },
    };
    const { clock, deps, store } = createDeps({
      items: [inProgressItem],
      providerId: 'codex',
      outboxStore: outbox,
      inboxNudge: inbox,
    });
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
      taskIds: ['task-1'],
      leaseTtlMs: 120_000,
      source: 'test',
    });

    clock.set('2026-04-29T00:10:00.000Z');
    store.phase2ReadinessState = 'blocked';
    store.phase2ReadinessReasons = ['would_nudge_rate_high'];
    store.metricsGeneratedAt = '2026-04-29T00:10:00.000Z';
    store.recentEvents = [
      {
        id: 'old-report-accepted',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'report_accepted',
        state: 'still_working',
        agendaFingerprint: current.agenda.fingerprint,
        recordedAt: '2026-04-29T00:01:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
      {
        id: 'needs-sync-after-lease-expired',
        teamName: 'team-a',
        memberName: 'bob',
        kind: 'status_evaluated',
        state: 'needs_sync',
        agendaFingerprint: current.agenda.fingerprint,
        recordedAt: '2026-04-29T00:04:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
    ];

    const summary = await new MemberWorkSyncNudgeDispatcher(deps).dispatchDue({
      teamNames: ['team-a'],
      claimedBy: 'test-dispatcher',
    });

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retryable: 0 });
    expect(inbox.inserted).toHaveLength(1);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'delivered',
    });
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

  it('uses the watchdog cooldown retry deadline instead of exponential retry backoff', async () => {
    const outbox = new InMemoryOutboxStore();
    const inbox = new InMemoryInboxNudge();
    const { deps, store } = createDeps({
      outboxStore: outbox,
      inboxNudge: inbox,
      watchdogCooldown: {
        hasRecentNudge: async () => true,
        getRecentNudgeCooldown: async () => ({
          active: true,
          retryAfterIso: '2026-04-29T00:10:00.000Z',
        }),
      },
    });
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

    expect(summary).toMatchObject({ claimed: 1, delivered: 0, retryable: 1 });
    expect(inbox.inserted).toEqual([]);
    expect(
      outbox.items.get(`member-work-sync:team-a:bob:${current.agenda.fingerprint}`)
    ).toMatchObject({
      status: 'failed_retryable',
      lastError: 'watchdog_cooldown_active',
      nextAttemptAt: '2026-04-29T00:10:00.000Z',
    });
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

  it('refreshes expired fallback pending report tokens during replay', async () => {
    const { deps, store } = createDeps();
    const reader = new MemberWorkSyncReconciler(deps);
    const current = await reader.execute({ teamName: 'team-a', memberName: 'bob' });
    const baseReportToken = deps.reportToken!;
    deps.reportToken = {
      create: baseReportToken.create,
      verify: async (input) =>
        input.token === 'expired-token'
          ? { ok: false, reason: 'expired' }
          : baseReportToken.verify(input),
    };
    store.pendingIntents.set('intent-1', {
      id: 'intent-1',
      teamName: 'team-a',
      memberName: 'bob',
      status: 'pending',
      reason: 'control_api_unavailable',
      recordedAt: '2026-04-29T00:16:00.000Z',
      request: {
        teamName: 'team-a',
        memberName: 'bob',
        state: 'still_working',
        agendaFingerprint: current.agenda.fingerprint,
        reportToken: 'expired-token',
        leaseTtlMs: 120_000,
        source: 'mcp',
      },
    });

    const summary = await new MemberWorkSyncPendingReportIntentReplayer(deps).replayTeam('team-a');

    expect(summary).toEqual({ processed: 1, accepted: 1, rejected: 0, superseded: 0 });
    expect(store.pendingIntents.get('intent-1')).toMatchObject({
      status: 'accepted',
      resultCode: 'accepted',
    });
    expect(store.writes.at(-1)?.report).toMatchObject({
      accepted: true,
      source: 'mcp',
      state: 'still_working',
    });
  });

  it('rejects invalid fallback pending report tokens without refreshing identity', async () => {
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
        reportToken: 'invalid-token',
        leaseTtlMs: 120_000,
        source: 'mcp',
      },
    });

    const summary = await new MemberWorkSyncPendingReportIntentReplayer(deps).replayTeam('team-a');

    expect(summary).toEqual({ processed: 1, accepted: 0, rejected: 1, superseded: 0 });
    expect(store.pendingIntents.get('intent-1')).toMatchObject({
      status: 'rejected',
      resultCode: 'invalid_report_token',
    });
    expect(store.writes.at(-1)?.report).toMatchObject({
      accepted: false,
      rejectionCode: 'invalid_report_token',
    });
  });

  it('supersedes pending controller intents when the member runtime is inactive', async () => {
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

    const summary = await new MemberWorkSyncPendingReportIntentReplayer({
      ...deps,
      lifecycle: {
        isTeamActive: () => true,
        isMemberActive: () => false,
      },
    }).replayTeam('team-a');

    expect(summary).toEqual({ processed: 1, accepted: 0, rejected: 0, superseded: 1 });
    expect(store.pendingIntents.get('intent-1')).toMatchObject({
      status: 'superseded',
      resultCode: 'member_runtime_inactive',
    });
  });
});
