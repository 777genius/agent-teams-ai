import { createLogger } from '@shared/utils/logger';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import {
  getOpenCodeWeakStartStallThresholdMs,
  getTeamTaskStallActivationGraceMs,
  getTeamTaskStallScanIntervalMs,
  getTeamTaskStallStartupGraceMs,
  isOpenCodeTaskStallRemediationEnabled,
  isTeamTaskStallAlertsEnabled,
  isTeamTaskStallMonitorEnabled,
  isTeamTaskStallScannerEnabled,
} from './featureGates';
import { getOpenWorkInterval } from './TeamTaskStallPolicy';

import type { ActiveTeamRegistry } from './ActiveTeamRegistry';
import type { TeamTaskStallJournal } from './TeamTaskStallJournal';
import type { TeamTaskStallNotifier } from './TeamTaskStallNotifier';
import type { TeamTaskStallPolicy } from './TeamTaskStallPolicy';
import type { TeamTaskStallSnapshotSource } from './TeamTaskStallSnapshotSource';
import type { TaskStallAlert, TaskStallEvaluation } from './TeamTaskStallTypes';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamTaskStallMonitor');

interface TeamObservationState {
  firstSeenAtMs: number;
  lastActivationAtMs: number;
}

interface TeamTaskStallMonitorOptions {
  scanTimeoutMs?: number;
}

interface TeamTaskStallScanRun {
  cancelled: boolean;
}

const DEFAULT_TEAM_TASK_STALL_SCAN_TIMEOUT_MS = 2 * 60_000;
const OPENCODE_SKIP_LOG_INTERVAL_MS = 10 * 60_000;
const OPENCODE_HELD_ALERT_LOG_DELAY_MS = 2 * 60_000;

/** Rungs of the pickup ladder: nudge the owner once, tell the lead once, then stop. */
const PICKUP_ESCALATION_RUNGS = 2;

interface PickupEscalationState {
  priorAlertCount: number;
  clockMs: number;
}

interface PickupEscalationPlan {
  ownerAlerts: TaskStallAlert[];
  leadOnlyAlerts: TaskStallAlert[];
  silencedAlerts: TaskStallAlert[];
  /** The subset of silenced alerts whose ladder ran out on this scan; logged once. */
  newlyExhaustedAlerts: TaskStallAlert[];
}

/** Missing or unparsable clocks sort last so a known-oldest task wins the scan. */
function parsePickupClockMs(readyAt: string | undefined): number {
  const parsed = readyAt ? Date.parse(readyAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function unrefBackgroundTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

export class TeamTaskStallMonitor {
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanInFlight = false;
  private started = false;
  private readonly activeScanBodies = new Map<TeamTaskStallScanRun, Promise<void>>();
  private stopPromise: Promise<void> | null = null;
  private readonly observationByTeam = new Map<string, TeamObservationState>();
  private readonly scanTimeoutMs: number;

  constructor(
    private readonly registry: ActiveTeamRegistry,
    private readonly snapshotSource: TeamTaskStallSnapshotSource,
    private readonly policy: TeamTaskStallPolicy,
    private readonly journal: TeamTaskStallJournal,
    private readonly notifier: TeamTaskStallNotifier,
    options: TeamTaskStallMonitorOptions = {}
  ) {
    this.scanTimeoutMs = Math.max(
      1,
      options.scanTimeoutMs ?? DEFAULT_TEAM_TASK_STALL_SCAN_TIMEOUT_MS
    );
  }

  start(): void {
    if (this.stopPromise) {
      return;
    }
    if (!isTeamTaskStallScannerEnabled()) {
      logger.debug('Task stall monitor disabled by feature gate');
      return;
    }
    if (this.started) {
      return;
    }
    this.started = true;
    this.registry.start();
    this.scheduleNextScan(2_000);
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.started = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    for (const scanRun of this.activeScanBodies.keys()) {
      scanRun.cancelled = true;
    }

    const registryStop = Promise.resolve().then(() => this.registry.stop());
    this.stopPromise = Promise.allSettled([
      registryStop,
      Promise.allSettled([...this.activeScanBodies.values()]),
    ]).then(([registryStopResult]) => {
      if (registryStopResult.status === 'rejected') {
        throw registryStopResult.reason;
      }
    });
    return this.stopPromise;
  }

  noteTeamChange(event: TeamChangeEvent): void {
    if (this.stopPromise || !isTeamTaskStallScannerEnabled()) {
      return;
    }
    this.registry.noteTeamChange(event);

    if (
      event.type === 'member-spawn' ||
      (event.type === 'lead-activity' && event.detail !== 'offline')
    ) {
      const now = Date.now();
      const existing = this.observationByTeam.get(event.teamName);
      this.observationByTeam.set(event.teamName, {
        firstSeenAtMs: existing?.firstSeenAtMs ?? now,
        lastActivationAtMs: now,
      });
      this.scheduleNudgedScan();
      return;
    }

    if (event.type === 'task-log-change' || event.type === 'log-source-change') {
      this.scheduleNudgedScan();
    }
  }

  private scheduleNextScan(delayMs: number): void {
    if (!this.started) {
      return;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.runScan();
    }, delayMs);
    unrefBackgroundTimer(this.scanTimer);
  }

  private scheduleNudgedScan(): void {
    if (!this.started || this.nudgeTimer) {
      return;
    }
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.runScan();
    }, 5_000);
    unrefBackgroundTimer(this.nudgeTimer);
  }

  private async runScan(): Promise<void> {
    if (!this.started || this.scanInFlight) {
      return;
    }
    this.scanInFlight = true;
    const scanRun: TeamTaskStallScanRun = { cancelled: false };
    const scanBody = this.runScanBody(scanRun);
    this.activeScanBodies.set(scanRun, scanBody);
    void scanBody.then(
      () => this.activeScanBodies.delete(scanRun),
      () => this.activeScanBodies.delete(scanRun)
    );
    try {
      await this.runScanWithTimeout(scanRun, scanBody);
    } catch (error) {
      logger.warn(`Task stall monitor scan failed: ${String(error)}`);
    } finally {
      scanRun.cancelled = true;
      this.scanInFlight = false;
      this.scheduleNextScan(getTeamTaskStallScanIntervalMs());
    }
  }

  private async runScanWithTimeout(
    scanRun: TeamTaskStallScanRun,
    scanBody: Promise<void>
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        scanBody,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            scanRun.cancelled = true;
            reject(new Error(`task stall monitor scan timed out after ${this.scanTimeoutMs}ms`));
          }, this.scanTimeoutMs);
          unrefBackgroundTimer(timeout);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private shouldContinueScan(scanRun: TeamTaskStallScanRun): boolean {
    return this.started && !scanRun.cancelled;
  }

  private async runScanBody(scanRun: TeamTaskStallScanRun): Promise<void> {
    const activeTeams = await this.registry.listActiveTeams();
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    const activeSet = new Set(activeTeams);
    for (const teamName of [...this.observationByTeam.keys()]) {
      if (!activeSet.has(teamName)) {
        this.observationByTeam.delete(teamName);
      }
    }

    const now = new Date();
    this.pruneDiagnosticState(activeSet, now.getTime());

    const eligibleTeamNames: string[] = [];
    for (const teamName of activeTeams) {
      const observation = this.getOrCreateObservation(teamName, now.getTime());
      const startupAgeMs = now.getTime() - observation.firstSeenAtMs;
      if (startupAgeMs < getTeamTaskStallStartupGraceMs()) {
        continue;
      }

      const activationAgeMs = now.getTime() - observation.lastActivationAtMs;
      if (activationAgeMs < getTeamTaskStallActivationGraceMs()) {
        continue;
      }

      eligibleTeamNames.push(teamName);
    }

    if (!this.shouldContinueScan(scanRun) || eligibleTeamNames.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      eligibleTeamNames.map((teamName) => this.scanTeam(teamName, now, scanRun))
    );
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected' && this.shouldContinueScan(scanRun)) {
        logger.warn(
          `Task stall monitor scan failed for ${eligibleTeamNames[index]}: ${String(result.reason)}`
        );
      }
    }
  }

  private getOrCreateObservation(teamName: string, nowMs: number): TeamObservationState {
    const existing = this.observationByTeam.get(teamName);
    if (existing) {
      return existing;
    }
    const created = {
      firstSeenAtMs: nowMs,
      lastActivationAtMs: nowMs,
    };
    this.observationByTeam.set(teamName, created);
    return created;
  }

  private async scanTeam(
    teamName: string,
    now: Date,
    scanRun: TeamTaskStallScanRun
  ): Promise<void> {
    const snapshot = await this.snapshotSource.getSnapshot(teamName);
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    if (!snapshot) {
      return;
    }

    const evaluations: TaskStallEvaluation[] = [];
    for (const task of snapshot.inProgressTasks) {
      evaluations.push(this.policy.evaluateWork({ now, task, snapshot }));
    }
    this.logOpenCodeOwnerSkips(snapshot, evaluations, now);
    for (const task of snapshot.pendingPickupTasks ?? []) {
      evaluations.push(this.policy.evaluatePendingPickup({ now, task, snapshot }));
    }
    for (const task of snapshot.reviewOpenTasks) {
      evaluations.push(this.policy.evaluateReview({ now, task, snapshot }));
    }

    const fullMonitorEnabled = isTeamTaskStallMonitorEnabled();
    const openCodeRemediationEnabled = isOpenCodeTaskStallRemediationEnabled();
    const openCodeOnlyMode = openCodeRemediationEnabled && !fullMonitorEnabled;
    const scopedTaskIds = openCodeOnlyMode ? this.getOpenCodeOwnedTaskIds(snapshot) : undefined;
    const journalEvaluations = openCodeOnlyMode
      ? evaluations.filter((evaluation) => this.isOpenCodeOwnerWorkEvaluation(snapshot, evaluation))
      : evaluations;
    // Pickup candidates must be in this set: the journal prunes any entry whose
    // task is not active, so leaving them out would reset the two-scan counter
    // on every scan and the pickup branch would never alert.
    const activeTaskIds = [
      ...new Set(
        [
          ...snapshot.inProgressTasks,
          ...snapshot.reviewOpenTasks,
          ...(snapshot.pendingPickupTasks ?? []),
        ].map((task) => task.id)
      ),
    ];
    const readyEvaluations = await this.journal.reconcileScan({
      teamName,
      evaluations: journalEvaluations,
      activeTaskIds,
      ...(scopedTaskIds ? { scopeTaskIds: scopedTaskIds } : {}),
      now: now.toISOString(),
    });
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    this.logOpenCodeOwnerAlertsHeldByJournal(snapshot, journalEvaluations, readyEvaluations, now);

    const alerts = readyEvaluations
      .map((evaluation) => this.buildAlert(snapshot, evaluation))
      .filter((alert): alert is TaskStallAlert => alert !== null);

    if (alerts.length === 0) {
      return;
    }

    const { ownerAlerts, leadOnlyAlerts, silencedAlerts, newlyExhaustedAlerts } =
      this.planPickupEscalation(alerts, readyEvaluations);
    this.logExhaustedPickupEscalations(teamName, newlyExhaustedAlerts);
    const routableAlerts = [...ownerAlerts, ...leadOnlyAlerts];

    const alertedEpochKeys = new Set<string>();
    if (openCodeRemediationEnabled && ownerAlerts.length > 0) {
      const remediatedAlerts = await this.notifier.notifyOpenCodeOwners(teamName, ownerAlerts);
      if (!this.shouldContinueScan(scanRun)) {
        return;
      }
      for (const alert of remediatedAlerts) {
        alertedEpochKeys.add(alert.epochKey);
      }
    }

    const leadFallbackAlerts = routableAlerts.filter(
      (alert) => !alertedEpochKeys.has(alert.epochKey)
    );
    if (leadFallbackAlerts.length > 0 && isTeamTaskStallAlertsEnabled()) {
      await this.notifier.notifyLead(teamName, leadFallbackAlerts);
      if (!this.shouldContinueScan(scanRun)) {
        return;
      }
      for (const alert of leadFallbackAlerts) {
        alertedEpochKeys.add(alert.epochKey);
      }
    }

    // A silenced rung is journaled too: the cooldown is what keeps an abandoned
    // task from being re-evaluated on every scan.
    const journaledAlerts = [
      ...routableAlerts.filter((alert) => alertedEpochKeys.has(alert.epochKey)),
      ...silencedAlerts,
    ];
    if (journaledAlerts.length === 0) {
      logger.debug(`Task stall monitor shadow-ready alerts for ${teamName}: ${alerts.length}`);
      return;
    }

    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    await Promise.all(
      journaledAlerts.map((alert) =>
        this.journal.markAlerted(teamName, alert.epochKey, now.toISOString())
      )
    );
  }

  /**
   * Pickup alerts climb a bounded ladder - owner nudge, then lead alert, then
   * silence - and only the oldest pending task per member reaches that member's
   * lane in one scan. Alerts held back by the per-member cap are left
   * unjournaled so the next scan reconsiders them instead of burning a rung.
   */
  private planPickupEscalation(
    alerts: TaskStallAlert[],
    readyEvaluations: TaskStallEvaluation[]
  ): PickupEscalationPlan {
    const stateByEpochKey = new Map<string, PickupEscalationState>();
    for (const evaluation of readyEvaluations) {
      if (!evaluation.epochKey) continue;
      stateByEpochKey.set(evaluation.epochKey, {
        priorAlertCount: evaluation.priorAlertCount ?? 0,
        clockMs: parsePickupClockMs(evaluation.readyAt),
      });
    }

    const plan: PickupEscalationPlan = {
      ownerAlerts: [],
      leadOnlyAlerts: [],
      silencedAlerts: [],
      newlyExhaustedAlerts: [],
    };
    const pickupAlertsByMember = new Map<string, TaskStallAlert[]>();
    for (const alert of alerts) {
      if (alert.remediationKind !== 'pending_pickup') {
        plan.ownerAlerts.push(alert);
        continue;
      }
      const priorAlertCount = stateByEpochKey.get(alert.epochKey)?.priorAlertCount ?? 0;
      if (priorAlertCount >= PICKUP_ESCALATION_RUNGS) {
        plan.silencedAlerts.push(alert);
        if (priorAlertCount === PICKUP_ESCALATION_RUNGS) {
          plan.newlyExhaustedAlerts.push(alert);
        }
        continue;
      }
      const memberKey = alert.owner?.trim().toLowerCase() ?? '';
      const memberAlerts = pickupAlertsByMember.get(memberKey);
      if (memberAlerts) {
        memberAlerts.push(alert);
      } else {
        pickupAlertsByMember.set(memberKey, [alert]);
      }
    }

    for (const memberAlerts of pickupAlertsByMember.values()) {
      const oldest = [...memberAlerts].sort((left, right) => {
        const leftMs = stateByEpochKey.get(left.epochKey)?.clockMs ?? Number.POSITIVE_INFINITY;
        const rightMs = stateByEpochKey.get(right.epochKey)?.clockMs ?? Number.POSITIVE_INFINITY;
        if (leftMs !== rightMs) {
          return leftMs < rightMs ? -1 : 1;
        }
        return left.taskId.localeCompare(right.taskId);
      })[0];
      if (!oldest) continue;
      if ((stateByEpochKey.get(oldest.epochKey)?.priorAlertCount ?? 0) === 0) {
        plan.ownerAlerts.push(oldest);
      } else {
        plan.leadOnlyAlerts.push(oldest);
      }
    }

    return plan;
  }

  /**
   * Logged once per epoch, on the scan the ladder runs out. Later scans keep
   * silencing the same alert but say nothing, so an abandoned task does not
   * repeat a warn line for the rest of the run.
   */
  private logExhaustedPickupEscalations(
    teamName: string,
    newlyExhaustedAlerts: TaskStallAlert[]
  ): void {
    for (const alert of newlyExhaustedAlerts) {
      logger.warn(
        `[${teamName}] Stall monitor stopped escalating task #${alert.displayId} (owner ${alert.owner ?? 'unknown'}): pickup_escalation_exhausted - the owner nudge and the lead alert are spent and the task is still pending.`
      );
    }
  }

  private buildAlert(
    snapshot: Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>,
    evaluation: TaskStallEvaluation
  ): TaskStallAlert | null {
    if (
      !snapshot ||
      evaluation.status !== 'alert' ||
      !evaluation.taskId ||
      !evaluation.branch ||
      !evaluation.signal ||
      !evaluation.epochKey
    ) {
      return null;
    }

    const task = snapshot.allTasksById.get(evaluation.taskId);
    if (!task) {
      return null;
    }

    const displayId = getTaskDisplayId(task);
    const ownerProviderId = task.owner
      ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
      : undefined;
    return {
      teamName: snapshot.teamName,
      taskId: task.id,
      displayId,
      subject: task.subject,
      branch: evaluation.branch,
      signal: evaluation.signal,
      ...(evaluation.progressSignal ? { progressSignal: evaluation.progressSignal } : {}),
      ...(evaluation.remediationKind ? { remediationKind: evaluation.remediationKind } : {}),
      reason: evaluation.reason,
      epochKey: evaluation.epochKey,
      ...(task.owner ? { owner: task.owner } : {}),
      ...(ownerProviderId ? { ownerProviderId } : {}),
      taskRef: {
        taskId: task.id,
        displayId,
        teamName: snapshot.teamName,
      },
    };
  }

  /**
   * Diagnosability: an OpenCode owner whose task has been in progress longer
   * than the OpenCode stall threshold but was not alerted is logged at warn
   * level (once per task and reason per cooldown) so the next "the monitor
   * never fired" report can be read out of the error log instead of guessed at.
   */
  private readonly openCodeSkipLogAtByKey = new Map<string, number>();
  private readonly heldAlertFirstSeenAtByTeam = new Map<string, Map<string, number>>();

  private shouldLogOpenCodeSkip(key: string, nowMs: number): boolean {
    const last = this.openCodeSkipLogAtByKey.get(key);
    if (last !== undefined && nowMs - last < OPENCODE_SKIP_LOG_INTERVAL_MS) {
      return false;
    }
    this.openCodeSkipLogAtByKey.set(key, nowMs);
    return true;
  }

  /**
   * Both diagnostic maps are keyed by data that turns over inside a live team -
   * task ids, and epoch keys that carry a touch timestamp - so the monitor,
   * which runs for the whole main-process lifetime, would otherwise keep one
   * dead entry per task and per epoch forever. Neither bound is an arbitrary
   * cap: each entry is dropped when it can no longer affect a decision.
   */
  private pruneDiagnosticState(activeTeamNames: Set<string>, nowMs: number): void {
    // A rate-limit stamp older than its own interval cannot suppress anything:
    // shouldLogOpenCodeSkip would return true for that key either way, so
    // dropping it is exactly equivalent to keeping it.
    for (const [key, loggedAtMs] of this.openCodeSkipLogAtByKey) {
      if (nowMs - loggedAtMs >= OPENCODE_SKIP_LOG_INTERVAL_MS) {
        this.openCodeSkipLogAtByKey.delete(key);
      }
    }
    // Held-alert clocks belong to a team's live scan. A team that is no longer
    // running has no held alerts, and its next launch starts a fresh journal.
    for (const teamName of this.heldAlertFirstSeenAtByTeam.keys()) {
      if (!activeTeamNames.has(teamName)) {
        this.heldAlertFirstSeenAtByTeam.delete(teamName);
      }
    }
  }

  private describeOpenCodeLane(
    snapshot: NonNullable<Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>>,
    owner: string | undefined
  ): string {
    const key = owner?.trim().toLowerCase() ?? '';
    // Timestamp first, always: a bare "lane active" is what made the original
    // suppression unreadable after the fact.
    const staleActiveSince = snapshot.openCodeLaneStaleActiveSinceByMemberName?.get(key);
    if (staleActiveSince) {
      return `lane turn sample stale-active since ${staleActiveSince} (demoted to idle)`;
    }
    const idleSince = snapshot.openCodeLaneIdleSinceByMemberName?.get(key);
    if (idleSince) return `lane idle since ${idleSince}`;
    if (snapshot.openCodeLaneActiveMemberNames?.has(key)) {
      const activeSince = snapshot.openCodeLaneActiveSinceByMemberName?.get(key);
      return activeSince ? `lane active since ${activeSince}` : 'lane active';
    }
    return 'lane state unknown';
  }

  private logOpenCodeOwnerSkips(
    snapshot: NonNullable<Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>>,
    evaluations: TaskStallEvaluation[],
    now: Date
  ): void {
    const thresholdMs = getOpenCodeWeakStartStallThresholdMs();
    for (const evaluation of evaluations) {
      if (evaluation.status !== 'skip' || !evaluation.taskId) continue;
      const task = snapshot.allTasksById.get(evaluation.taskId);
      if (!task?.owner || task.status !== 'in_progress') continue;
      const ownerProviderId = snapshot.providerByMemberName.get(task.owner.trim().toLowerCase());
      if (ownerProviderId !== 'opencode') continue;
      const startedAt = getOpenWorkInterval(task)?.startedAt;
      const inProgressMs = startedAt ? now.getTime() - Date.parse(startedAt) : Number.NaN;
      if (!Number.isFinite(inProgressMs) || inProgressMs < thresholdMs) continue;
      const key = `${snapshot.teamName}:${task.id}:${evaluation.skipReason ?? 'skip'}`;
      if (!this.shouldLogOpenCodeSkip(key, now.getTime())) continue;
      logger.warn(
        `[${snapshot.teamName}] Stall monitor did not alert OpenCode task #${getTaskDisplayId(task)} (owner ${task.owner}, in progress ${Math.round(inProgressMs / 60_000)} min): ${evaluation.skipReason ?? 'skip'} - ${evaluation.reason}; ${this.describeOpenCodeLane(snapshot, task.owner)}`
      );
    }
  }

  private logOpenCodeOwnerAlertsHeldByJournal(
    snapshot: NonNullable<Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>>,
    evaluations: TaskStallEvaluation[],
    readyEvaluations: TaskStallEvaluation[],
    now: Date
  ): void {
    const readyKeys = new Set(readyEvaluations.map((evaluation) => evaluation.epochKey));
    const previousFirstSeenAt = this.heldAlertFirstSeenAtByTeam.get(snapshot.teamName);
    // Rebuilt from this scan rather than mutated: an epoch that became ready,
    // stopped being an OpenCode work alert or left the board entirely is not
    // carried over, so the map holds only the alerts still being held.
    const stillHeldFirstSeenAt = new Map<string, number>();
    for (const evaluation of evaluations) {
      if (evaluation.status !== 'alert' || !evaluation.taskId || !evaluation.epochKey) continue;
      if (readyKeys.has(evaluation.epochKey)) continue;
      if (!this.isOpenCodeOwnerWorkEvaluation(snapshot, evaluation)) continue;
      // The journal holds every alert on the scan that first sees it; only a
      // hold that outlives that rule is worth a log line.
      const firstSeenAt = previousFirstSeenAt?.get(evaluation.epochKey) ?? now.getTime();
      stillHeldFirstSeenAt.set(evaluation.epochKey, firstSeenAt);
      if (now.getTime() - firstSeenAt < OPENCODE_HELD_ALERT_LOG_DELAY_MS) continue;
      const task = snapshot.allTasksById.get(evaluation.taskId);
      const key = `${snapshot.teamName}:${evaluation.epochKey}:journal_hold`;
      if (!this.shouldLogOpenCodeSkip(key, now.getTime())) continue;
      logger.warn(
        `[${snapshot.teamName}] Stall alert for OpenCode task #${task ? getTaskDisplayId(task) : evaluation.taskId} (owner ${evaluation.memberName ?? task?.owner ?? 'unknown'}) is held by the stall journal (cooldown or first-scan rule): ${evaluation.reason}`
      );
    }

    if (stillHeldFirstSeenAt.size > 0) {
      this.heldAlertFirstSeenAtByTeam.set(snapshot.teamName, stillHeldFirstSeenAt);
    } else {
      this.heldAlertFirstSeenAtByTeam.delete(snapshot.teamName);
    }
  }

  private isOpenCodeOwnerWorkEvaluation(
    snapshot: Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>,
    evaluation: TaskStallEvaluation
  ): boolean {
    if (
      !snapshot ||
      evaluation.status !== 'alert' ||
      evaluation.branch !== 'work' ||
      !evaluation.taskId
    ) {
      return false;
    }

    const task = snapshot.allTasksById.get(evaluation.taskId);
    const ownerProviderId = task?.owner
      ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
      : undefined;
    return ownerProviderId === 'opencode';
  }

  private getOpenCodeOwnedTaskIds(
    snapshot: NonNullable<Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>>
  ): string[] {
    return [...snapshot.allTasksById.values()]
      .filter((task) => {
        const ownerProviderId = task.owner
          ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
          : undefined;
        return ownerProviderId === 'opencode';
      })
      .map((task) => task.id);
  }
}
