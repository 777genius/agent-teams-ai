import type {
  MemberWorkSyncAuditEvent,
  MemberWorkSyncAuditJournalPort,
  MemberWorkSyncLoggerPort,
} from '../../core/application';
import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';

export type MemberWorkSyncTriggerReason =
  | 'startup_scan'
  | 'config_changed'
  | 'task_changed'
  | 'inbox_changed'
  | 'member_spawned'
  | 'tool_finished'
  | 'runtime_activity'
  | 'turn_settled'
  | 'proof_missing_recovery'
  | 'manual_refresh';

export interface MemberWorkSyncQueueDiagnostics {
  queued: number;
  running: number;
  enqueued: number;
  coalesced: number;
  reconciled: number;
  dropped: number;
  failed: number;
  nextRunAt?: string;
  oldestQueuedAgeMs?: number;
  oldestRunningAgeMs?: number;
  queuedItems: MemberWorkSyncQueuedItemDiagnostics[];
  runningItems: MemberWorkSyncRunningItemDiagnostics[];
}

export interface MemberWorkSyncQueuedItemDiagnostics {
  teamName: string;
  memberName: string;
  firstQueuedAt: string;
  lastQueuedAt: string;
  runAt: string;
  maxRunAt: string;
  triggerReasons: MemberWorkSyncTriggerReason[];
  triggerReasonCounts: Partial<Record<MemberWorkSyncTriggerReason, number>>;
}

export interface MemberWorkSyncRunningItemDiagnostics {
  teamName: string;
  memberName: string;
  startedAt: string;
  ageMs: number;
  rerunRequested: boolean;
  triggerReasons: MemberWorkSyncTriggerReason[];
}

interface QueueItem {
  teamName: string;
  memberName: string;
  firstQueuedAt: number;
  lastQueuedAt: number;
  runAt: number;
  maxRunAt: number;
  triggerReasons: Set<MemberWorkSyncTriggerReason>;
  triggerReasonCounts: Map<MemberWorkSyncTriggerReason, number>;
  recovery?: MemberWorkSyncReconcileContext['recovery'];
}

interface RunningItem {
  teamName: string;
  memberName: string;
  startedAt: number;
  rerunRequested: boolean;
  triggerReasons: Set<MemberWorkSyncTriggerReason>;
  recovery?: MemberWorkSyncReconcileContext['recovery'];
}

interface TriggerTimingPolicy {
  runAfterMs: number;
  maxCoalesceWaitMs: number;
}

export interface MemberWorkSyncEventQueueDeps {
  reconcile(
    input: { teamName: string; memberName: string },
    context: MemberWorkSyncReconcileContext
  ): Promise<void>;
  isTeamActive(teamName: string): Promise<boolean> | boolean;
  quietWindowMs?: number;
  triggerTiming?: Partial<Record<MemberWorkSyncTriggerReason, Partial<TriggerTimingPolicy>>>;
  concurrency?: number;
  now?: () => number;
  nowIso?: () => string;
  auditJournal?: MemberWorkSyncAuditJournalPort;
  logger?: MemberWorkSyncLoggerPort;
}

function keyOf(teamName: string, memberName: string): string {
  return `${teamName}\0${memberName.trim().toLowerCase()}`;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export class MemberWorkSyncEventQueue {
  private readonly items = new Map<string, QueueItem>();
  private readonly running = new Map<string, RunningItem>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly quietWindowMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private counters = {
    enqueued: 0,
    coalesced: 0,
    reconciled: 0,
    dropped: 0,
    failed: 0,
  };

  constructor(private readonly deps: MemberWorkSyncEventQueueDeps) {
    this.quietWindowMs = deps.quietWindowMs ?? 90_000;
    this.concurrency = Math.max(1, deps.concurrency ?? 2);
    this.now = deps.now ?? Date.now;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  private resolveTimingPolicy(
    triggerReason: MemberWorkSyncTriggerReason,
    explicitRunAfterMs?: number
  ): TriggerTimingPolicy {
    const custom = this.deps.triggerTiming?.[triggerReason];
    const quietWindowFallback =
      this.deps.quietWindowMs != null && triggerReason !== 'manual_refresh';
    const runAfterMs = Math.max(
      0,
      explicitRunAfterMs ??
        custom?.runAfterMs ??
        (quietWindowFallback ? this.quietWindowMs : defaultRunAfterMs(triggerReason))
    );
    const maxCoalesceWaitMs = Math.max(
      runAfterMs,
      custom?.maxCoalesceWaitMs ??
        (quietWindowFallback
          ? Math.max(this.quietWindowMs, this.quietWindowMs * 5)
          : defaultMaxCoalesceWaitMs(triggerReason))
    );
    return { runAfterMs, maxCoalesceWaitMs };
  }

  enqueue(input: {
    teamName: string;
    memberName: string;
    triggerReason: MemberWorkSyncTriggerReason;
    runAfterMs?: number;
    recovery?: MemberWorkSyncReconcileContext['recovery'];
  }): void {
    if (this.stopped) {
      return;
    }

    const teamName = input.teamName.trim();
    const memberName = input.memberName.trim();
    if (!teamName || !memberName) {
      this.counters.dropped += 1;
      return;
    }

    const key = keyOf(teamName, memberName);
    const now = this.now();
    const timing = this.resolveTimingPolicy(input.triggerReason, input.runAfterMs);
    const runAt = now + timing.runAfterMs;
    const running = this.running.get(key);
    if (running) {
      running.rerunRequested = true;
      running.triggerReasons.add(input.triggerReason);
      if (input.recovery) {
        running.recovery = input.recovery;
      }
      this.counters.coalesced += 1;
      this.appendAudit({
        teamName,
        memberName,
        event: 'queue_coalesced',
        source: 'event_queue',
        reason: input.triggerReason,
      });
      return;
    }

    const existing = this.items.get(key);
    if (existing) {
      existing.triggerReasons.add(input.triggerReason);
      if (input.recovery) {
        existing.recovery = input.recovery;
      }
      existing.lastQueuedAt = now;
      existing.maxRunAt = Math.max(
        existing.maxRunAt,
        existing.firstQueuedAt + timing.maxCoalesceWaitMs
      );
      const preserveEarlierRun =
        existing.runAt <= now ||
        existing.triggerReasons.has('manual_refresh') ||
        input.triggerReason === 'manual_refresh' ||
        runAt < existing.runAt;
      existing.runAt = preserveEarlierRun
        ? Math.min(existing.runAt, runAt)
        : Math.min(Math.max(existing.runAt, runAt), existing.maxRunAt);
      incrementReasonCount(existing.triggerReasonCounts, input.triggerReason);
      this.counters.coalesced += 1;
      this.appendAudit({
        teamName,
        memberName,
        event: 'queue_coalesced',
        source: 'event_queue',
        reason: input.triggerReason,
      });
      this.schedule();
      return;
    }

    this.items.set(key, {
      teamName,
      memberName,
      firstQueuedAt: now,
      lastQueuedAt: now,
      runAt,
      maxRunAt: now + timing.maxCoalesceWaitMs,
      triggerReasons: new Set([input.triggerReason]),
      triggerReasonCounts: new Map([[input.triggerReason, 1]]),
      ...(input.recovery ? { recovery: input.recovery } : {}),
    });
    this.counters.enqueued += 1;
    this.appendAudit({
      teamName,
      memberName,
      event: 'queue_enqueued',
      source: 'event_queue',
      reason: input.triggerReason,
    });
    this.schedule();
  }

  dropTeam(teamName: string): void {
    for (const [key, item] of this.items) {
      if (item.teamName === teamName) {
        this.items.delete(key);
        this.counters.dropped += 1;
      }
    }
    this.schedule();
  }

  getDiagnostics(): MemberWorkSyncQueueDiagnostics {
    const now = this.now();
    const queuedItems = [...this.items.values()]
      .sort((left, right) => left.runAt - right.runAt)
      .map((item) => ({
        teamName: item.teamName,
        memberName: item.memberName,
        firstQueuedAt: new Date(item.firstQueuedAt).toISOString(),
        lastQueuedAt: new Date(item.lastQueuedAt).toISOString(),
        runAt: new Date(item.runAt).toISOString(),
        maxRunAt: new Date(item.maxRunAt).toISOString(),
        triggerReasons: [...item.triggerReasons].sort(),
        triggerReasonCounts: Object.fromEntries(item.triggerReasonCounts),
      }));
    const runningItems = [...this.running.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((item) => ({
        teamName: item.teamName,
        memberName: item.memberName,
        startedAt: new Date(item.startedAt).toISOString(),
        ageMs: Math.max(0, now - item.startedAt),
        rerunRequested: item.rerunRequested,
        triggerReasons: [...item.triggerReasons].sort(),
      }));
    const oldestQueuedAt =
      queuedItems.length > 0
        ? Math.min(...[...this.items.values()].map((item) => item.firstQueuedAt))
        : null;
    const oldestRunningAt =
      runningItems.length > 0
        ? Math.min(...[...this.running.values()].map((item) => item.startedAt))
        : null;
    const nextRunAt =
      this.items.size > 0 ? Math.min(...[...this.items.values()].map((item) => item.runAt)) : null;
    return {
      queued: this.items.size,
      running: this.running.size,
      ...this.counters,
      ...(nextRunAt != null ? { nextRunAt: new Date(nextRunAt).toISOString() } : {}),
      ...(oldestQueuedAt != null ? { oldestQueuedAgeMs: Math.max(0, now - oldestQueuedAt) } : {}),
      ...(oldestRunningAt != null
        ? { oldestRunningAgeMs: Math.max(0, now - oldestRunningAt) }
        : {}),
      queuedItems,
      runningItems,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.items.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.items.size === 0) {
      return;
    }
    if (this.running.size >= this.concurrency) {
      return;
    }

    const nextRunAt = Math.min(...[...this.items.values()].map((item) => item.runAt));
    const delayMs = Math.max(0, nextRunAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delayMs);
    unrefTimer(this.timer);
  }

  private pump(): void {
    if (this.stopped) {
      return;
    }

    const due = [...this.items.entries()]
      .filter(([, item]) => item.runAt <= this.now())
      .sort((left, right) => left[1].runAt - right[1].runAt);

    for (const [key, item] of due) {
      if (this.running.size >= this.concurrency) {
        break;
      }
      this.items.delete(key);
      this.runItem(key, item);
    }

    this.schedule();
  }

  private runItem(key: string, item: QueueItem): void {
    const running: RunningItem = {
      teamName: item.teamName,
      memberName: item.memberName,
      startedAt: this.now(),
      rerunRequested: false,
      triggerReasons: new Set(item.triggerReasons),
      ...(item.recovery ? { recovery: item.recovery } : {}),
    };
    this.running.set(key, running);

    const promise = this.executeItem(key, item, running)
      .catch((error: unknown) => {
        this.counters.failed += 1;
        this.deps.logger?.warn('member work sync queue reconcile failed', {
          teamName: item.teamName,
          memberName: item.memberName,
          error: String(error),
        });
      })
      .finally(() => {
        this.running.delete(key);
        this.inFlight.delete(promise);
        if (running.rerunRequested && !this.stopped) {
          this.enqueueFollowUp(item, running);
        }
        this.pump();
      });

    this.inFlight.add(promise);
  }

  private enqueueFollowUp(item: QueueItem, running: RunningItem): void {
    const reasons = [...running.triggerReasons].sort();
    const recovery = running.recovery ?? item.recovery;
    const primaryReason =
      reasons.find((reason) => reason === 'manual_refresh') ??
      reasons.find((reason) => reason === 'turn_settled' || reason === 'tool_finished') ??
      reasons[0] ??
      'manual_refresh';
    this.enqueue({
      teamName: item.teamName,
      memberName: item.memberName,
      triggerReason: primaryReason,
      runAfterMs: Math.min(this.resolveTimingPolicy(primaryReason).runAfterMs, 5_000),
      ...(recovery ? { recovery } : {}),
    });
    const queued = this.items.get(keyOf(item.teamName, item.memberName));
    if (!queued) {
      return;
    }
    for (const reason of reasons) {
      queued.triggerReasons.add(reason);
      if (reason !== primaryReason) {
        incrementReasonCount(queued.triggerReasonCounts, reason);
      }
    }
  }

  private async executeItem(_key: string, item: QueueItem, running: RunningItem): Promise<void> {
    if (!(await this.deps.isTeamActive(item.teamName))) {
      this.counters.dropped += 1;
      this.appendAudit({
        teamName: item.teamName,
        memberName: item.memberName,
        event: 'queue_dropped',
        source: 'event_queue',
        reason: 'team_inactive',
      });
      return;
    }

    const recovery = running.recovery ?? item.recovery;
    await this.deps.reconcile(
      { teamName: item.teamName, memberName: item.memberName },
      {
        reconciledBy: 'queue',
        triggerReasons: [...running.triggerReasons].sort(),
        ...(recovery ? { recovery } : {}),
      }
    );
    this.counters.reconciled += 1;
    this.appendAudit({
      teamName: item.teamName,
      memberName: item.memberName,
      event: 'queue_reconciled',
      source: 'event_queue',
      triggerReasons: [...running.triggerReasons].sort(),
    });
  }

  private appendAudit(input: Omit<MemberWorkSyncAuditEvent, 'timestamp'>): void {
    if (!this.deps.auditJournal) {
      return;
    }
    void this.deps.auditJournal
      .append({
        ...input,
        timestamp: this.nowIso(),
      })
      .catch((error: unknown) => {
        this.deps.logger?.warn('member work sync queue audit append failed', {
          teamName: input.teamName,
          memberName: input.memberName,
          event: input.event,
          error: String(error),
        });
      });
  }
}

function incrementReasonCount(
  counts: Map<MemberWorkSyncTriggerReason, number>,
  reason: MemberWorkSyncTriggerReason
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function defaultRunAfterMs(reason: MemberWorkSyncTriggerReason): number {
  switch (reason) {
    case 'manual_refresh':
      return 0;
    case 'proof_missing_recovery':
      return 5_000;
    case 'turn_settled':
    case 'tool_finished':
      return 5_000;
    case 'task_changed':
    case 'inbox_changed':
    case 'runtime_activity':
      return 15_000;
    case 'startup_scan':
    case 'config_changed':
    case 'member_spawned':
      return 30_000;
  }
}

function defaultMaxCoalesceWaitMs(reason: MemberWorkSyncTriggerReason): number {
  switch (reason) {
    case 'manual_refresh':
      return 0;
    case 'proof_missing_recovery':
      return 30_000;
    case 'turn_settled':
    case 'tool_finished':
      return 30_000;
    case 'task_changed':
    case 'inbox_changed':
    case 'runtime_activity':
      return 60_000;
    case 'startup_scan':
    case 'config_changed':
    case 'member_spawned':
      return 90_000;
  }
}
