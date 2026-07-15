import {
  MemberWorkSyncDiagnosticsReader,
  MemberWorkSyncMetricsReader,
  MemberWorkSyncNudgeDispatcher,
  type MemberWorkSyncNudgeDispatchSummary,
  MemberWorkSyncPendingReportIntentReplayer,
  type MemberWorkSyncPendingReportReplaySummary,
  type MemberWorkSyncReconcileContext,
  MemberWorkSyncReconciler,
  MemberWorkSyncReporter,
  type RuntimeTurnSettledDrainSummary,
  RuntimeTurnSettledIngestor,
  type RuntimeTurnSettledTargetResolverPort,
} from '../../core/application';
import { MemberWorkSyncTaskImpactResolver } from '../adapters/input/MemberWorkSyncTaskImpactResolver';
import { MemberWorkSyncTeamChangeRouter } from '../adapters/input/MemberWorkSyncTeamChangeRouter';
import { TeamInboxMemberWorkSyncNudgeSink } from '../adapters/output/TeamInboxMemberWorkSyncNudgeSink';
import { TeamRuntimeTurnSettledTargetResolver } from '../adapters/output/TeamRuntimeTurnSettledTargetResolver';
import { TeamTaskAgendaSource } from '../adapters/output/TeamTaskAgendaSource';
import { TeamTaskStallJournalWorkSyncCooldown } from '../adapters/output/TeamTaskStallJournalWorkSyncCooldown';
import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import { ClaudeStopHookPayloadNormalizer } from '../infrastructure/ClaudeStopHookPayloadNormalizer';
import { CodexNativeTurnSettledPayloadNormalizer } from '../infrastructure/CodexNativeTurnSettledPayloadNormalizer';
import { CompositeMemberWorkSyncBusySignal } from '../infrastructure/CompositeMemberWorkSyncBusySignal';
import { CompositeRuntimeTurnSettledPayloadNormalizer } from '../infrastructure/CompositeRuntimeTurnSettledPayloadNormalizer';
import { FileMemberWorkSyncAuditJournal } from '../infrastructure/FileMemberWorkSyncAuditJournal';
import { FileRuntimeTurnSettledEventStore } from '../infrastructure/FileRuntimeTurnSettledEventStore';
import { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '../infrastructure/JsonMemberWorkSyncStore';
import {
  MemberWorkSyncEventQueue,
  type MemberWorkSyncQueueDiagnostics,
} from '../infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncNudgeDispatchScheduler } from '../infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { MemberWorkSyncSqliteImporter } from '../infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import { MemberWorkSyncToolActivityBusySignal } from '../infrastructure/MemberWorkSyncToolActivityBusySignal';
import { NodeHashAdapter } from '../infrastructure/NodeHashAdapter';
import { OpenCodeTurnSettledPayloadNormalizer } from '../infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { RuntimeTurnSettledDrainScheduler } from '../infrastructure/RuntimeTurnSettledDrainScheduler';
import { RuntimeTurnSettledSpoolInitializer } from '../infrastructure/RuntimeTurnSettledSpoolInitializer';
import { SqliteMemberWorkSyncStore } from '../infrastructure/SqliteMemberWorkSyncStore';
import { SystemClockAdapter } from '../infrastructure/SystemClockAdapter';

import type {
  MemberWorkSyncMetricsRequest,
  MemberWorkSyncReportRequest,
  MemberWorkSyncReportResult,
  MemberWorkSyncStatus,
  MemberWorkSyncStatusRequest,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncLoggerPort,
  MemberWorkSyncNudgeDeliveryWakePort,
  MemberWorkSyncProofMissingRecoveryGuardPort,
  MemberWorkSyncReviewPickupDeliveryPort,
  MemberWorkSyncReviewPickupEscalationPort,
} from '../../core/application';
import type { RuntimeTurnSettledProvider } from '../../core/domain';
import type { InternalStorageMemberWorkSyncBackend } from '@features/internal-storage/main';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import type { TeamChangeEvent } from '@shared/types';

const STALE_STATUS_MAX_AGE_MS = 2 * 60_000;
const CAUGHT_UP_STATUS_MAX_AGE_MS = 5 * 60_000;
const PROOF_MISSING_RECOVERY_RECENT_WINDOW_MS = 10 * 60_000;

function isAcceptedWorkLeaseStatus(status: MemberWorkSyncStatus): boolean {
  return (
    status.report?.accepted === true &&
    (status.state === 'still_working' || status.state === 'blocked')
  );
}

function getAcceptedWorkLeaseStaleness(
  status: MemberWorkSyncStatus,
  nowMs: number
): 'missing' | 'expired' | null {
  if (!isAcceptedWorkLeaseStatus(status)) {
    return null;
  }

  const reportExpiresAtMs = Date.parse(status.report?.expiresAt ?? '');
  if (!Number.isFinite(reportExpiresAtMs) || !Number.isFinite(nowMs)) {
    return 'missing';
  }
  return reportExpiresAtMs <= nowMs ? 'expired' : null;
}

function getReportTokenStaleness(
  status: MemberWorkSyncStatus,
  nowMs: number
): 'missing' | 'expired' | null {
  if (!status.reportToken?.trim()) {
    return 'missing';
  }

  const tokenExpiresAtMs = Date.parse(status.reportTokenExpiresAt ?? '');
  if (!Number.isFinite(tokenExpiresAtMs) || !Number.isFinite(nowMs)) {
    return 'missing';
  }

  return tokenExpiresAtMs <= nowMs ? 'expired' : null;
}

function isEmptyAgendaStaleState(status: MemberWorkSyncStatus): boolean {
  return (
    status.agenda.items.length === 0 &&
    (status.state === 'needs_sync' ||
      status.state === 'still_working' ||
      status.state === 'blocked' ||
      status.state === 'unknown')
  );
}

function statusNeedsBackgroundRefresh(status: MemberWorkSyncStatus, nowMs: number): boolean {
  if (getReportTokenStaleness(status, nowMs) !== null) {
    return true;
  }

  if (isEmptyAgendaStaleState(status)) {
    return true;
  }

  const evaluatedAtMs = Date.parse(status.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    return true;
  }

  if (status.state === 'caught_up' && nowMs - evaluatedAtMs > CAUGHT_UP_STATUS_MAX_AGE_MS) {
    return true;
  }

  if (status.agenda.items.length === 0) {
    return false;
  }

  if (status.state === 'needs_sync' && nowMs - evaluatedAtMs > STALE_STATUS_MAX_AGE_MS) {
    return true;
  }

  return getAcceptedWorkLeaseStaleness(status, nowMs) !== null;
}

function getStatusStalenessDiagnostics(status: MemberWorkSyncStatus, nowMs: number): string[] {
  const diagnostics: string[] = [];
  const tokenStaleness = getReportTokenStaleness(status, nowMs);
  if (tokenStaleness === 'missing') {
    diagnostics.push('report_token_missing_refresh_enqueued');
  } else if (tokenStaleness === 'expired') {
    diagnostics.push('report_token_expired_refresh_enqueued');
  }

  const evaluatedAtMs = Date.parse(status.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    diagnostics.push('status_evaluated_at_invalid');
  } else if (isEmptyAgendaStaleState(status)) {
    diagnostics.push('empty_agenda_state_refresh_enqueued');
  } else if (status.state === 'caught_up' && nowMs - evaluatedAtMs > CAUGHT_UP_STATUS_MAX_AGE_MS) {
    diagnostics.push('caught_up_stale_refresh_enqueued');
  } else if (
    status.agenda.items.length > 0 &&
    ['needs_sync', 'still_working', 'blocked'].includes(status.state) &&
    nowMs - evaluatedAtMs > STALE_STATUS_MAX_AGE_MS
  ) {
    diagnostics.push('status_stale_refresh_enqueued');
  }

  const leaseStaleness = getAcceptedWorkLeaseStaleness(status, nowMs);
  if (leaseStaleness === 'missing') {
    diagnostics.push('accepted_report_lease_missing_refresh_enqueued');
  } else if (leaseStaleness === 'expired') {
    diagnostics.push('accepted_report_lease_expired_refresh_enqueued');
  }

  return [...new Set(diagnostics)];
}

function shouldRefreshStatusSynchronously(stalenessDiagnostics: string[]): boolean {
  return stalenessDiagnostics.some(
    (diagnostic) => diagnostic !== 'caught_up_stale_refresh_enqueued'
  );
}

export function buildMemberWorkSyncRuntimeTurnSettledEnvironment(input: {
  teamsBasePath: string;
  provider: RuntimeTurnSettledProvider;
}): Promise<Record<string, string> | null> {
  return new RuntimeTurnSettledSpoolInitializer(input.teamsBasePath).buildEnvironment({
    provider: input.provider,
  });
}

export interface MemberWorkSyncFeatureFacade {
  getStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  refreshStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  getMetrics(request: MemberWorkSyncMetricsRequest): Promise<MemberWorkSyncTeamMetrics>;
  report(request: MemberWorkSyncReportRequest): Promise<MemberWorkSyncReportResult>;
  scheduleProofMissingRecovery(
    request: MemberWorkSyncProofMissingRecoveryScheduleRequest
  ): Promise<MemberWorkSyncProofMissingRecoveryScheduleResult>;
  noteTeamChange(event: TeamChangeEvent): void;
  enqueueStartupScan(teamNames: string[]): Promise<void>;
  replayPendingReports(teamNames: string[]): Promise<MemberWorkSyncPendingReportReplaySummary>;
  dispatchDueNudges(teamNames: string[]): Promise<MemberWorkSyncNudgeDispatchSummary>;
  buildRuntimeTurnSettledHookSettings(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, unknown> | null>;
  buildRuntimeTurnSettledEnvironment(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, string> | null>;
  drainRuntimeTurnSettledEvents(): Promise<RuntimeTurnSettledDrainSummary>;
  getQueueDiagnostics(): MemberWorkSyncQueueDiagnostics;
  dispose(): Promise<void>;
}

export interface MemberWorkSyncProofMissingRecoveryScheduleRequest {
  teamName: string;
  memberName: string;
  originalMessageId: string;
  taskRefs?: { taskId: string; displayId?: string; teamName?: string }[];
  reason?: string;
}

export interface MemberWorkSyncProofMissingRecoveryScheduleResult {
  scheduled: boolean;
  reason: 'scheduled' | 'coalesced_recent' | 'invalid';
  intentKey?: string;
  existingOutboxId?: string;
}

function buildProofMissingRecoveryIntentKey(originalMessageId: string): string {
  return `proof-missing:${originalMessageId}`;
}

function normalizeRecoveryTaskRefs(
  taskRefs: MemberWorkSyncProofMissingRecoveryScheduleRequest['taskRefs']
): { taskId: string; displayId?: string; teamName?: string }[] {
  const seen = new Set<string>();
  const normalized: { taskId: string; displayId?: string; teamName?: string }[] = [];
  for (const taskRef of taskRefs ?? []) {
    const taskId = taskRef.taskId.trim();
    if (!taskId || seen.has(taskId)) {
      continue;
    }
    seen.add(taskId);
    normalized.push({
      taskId,
      ...(taskRef.displayId?.trim() ? { displayId: taskRef.displayId.trim() } : {}),
      ...(taskRef.teamName?.trim() ? { teamName: taskRef.teamName.trim() } : {}),
    });
  }
  return normalized.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export function createMemberWorkSyncFeature(deps: {
  teamsBasePath: string;
  configReader: TeamConfigReader;
  taskReader: TeamTaskReader;
  kanbanManager: TeamKanbanManager;
  membersMetaStore: TeamMembersMetaStore;
  isTeamActive?: (teamName: string) => Promise<boolean> | boolean;
  isMemberActive?: (input: { teamName: string; memberName: string }) => Promise<boolean> | boolean;
  canDispatchNudges?: (teamName: string) => Promise<boolean> | boolean;
  listLifecycleActiveTeamNames?: () => Promise<string[]>;
  queueQuietWindowMs?: number;
  runtimeTurnSettledTargetResolver?: RuntimeTurnSettledTargetResolverPort;
  extraBusySignals?: MemberWorkSyncBusySignalPort[];
  proofMissingRecoveryGuard?: MemberWorkSyncProofMissingRecoveryGuardPort;
  nudgeDeliveryWake?: MemberWorkSyncNudgeDeliveryWakePort;
  resolveControlUrl?: () => Promise<string | null> | string | null;
  reviewPickupDelivery?: MemberWorkSyncReviewPickupDeliveryPort;
  reviewPickupEscalation?: MemberWorkSyncReviewPickupEscalationPort;
  /**
   * SQLite backend handle from the internal-storage feature. When present,
   * persistence routes through SQLite (with the JSON store as the session
   * fallback and one-time legacy import); when absent, JSON stays primary.
   */
  internalStorageBackend?: InternalStorageMemberWorkSyncBackend | null;
  logger?: MemberWorkSyncLoggerPort;
}): MemberWorkSyncFeatureFacade {
  const clock = new SystemClockAdapter();
  const hash = new NodeHashAdapter();
  const configReaderForReadOnlySync = {
    listTeams: () =>
      typeof deps.configReader.listTeams === 'function'
        ? deps.configReader.listTeams()
        : Promise.resolve([]),
    getConfig: (teamName: string) =>
      typeof deps.configReader.getConfigSnapshot === 'function'
        ? deps.configReader.getConfigSnapshot(teamName)
        : deps.configReader.getConfig(teamName),
  };
  const agendaSource = new TeamTaskAgendaSource({
    configReader: configReaderForReadOnlySync,
    taskReader: deps.taskReader,
    kanbanManager: deps.kanbanManager,
    membersMetaStore: deps.membersMetaStore,
    hash,
    clock,
  });
  const storePaths = new MemberWorkSyncStorePaths(deps.teamsBasePath);
  const auditJournal = new FileMemberWorkSyncAuditJournal(storePaths, deps.logger);
  const jsonStore = new JsonMemberWorkSyncStore(storePaths, {
    auditJournal,
    logger: deps.logger,
  });
  const store = deps.internalStorageBackend
    ? new BackendSelectingMemberWorkSyncStore(
        deps.internalStorageBackend.selector,
        new SqliteMemberWorkSyncStore({
          gateway: deps.internalStorageBackend.gateway,
          importer: new MemberWorkSyncSqliteImporter({
            gateway: deps.internalStorageBackend.gateway,
            jsonStore,
            logger: deps.logger,
          }),
          buildReportIntentId: buildPendingReportIntentId,
        }),
        jsonStore
      )
    : jsonStore;
  const runtimeTurnSettledSpool = new RuntimeTurnSettledSpoolInitializer(deps.teamsBasePath);
  const runtimeTurnSettledStore = new FileRuntimeTurnSettledEventStore({
    paths: runtimeTurnSettledSpool.getPaths(),
  });
  const runtimeTurnSettledNormalizer = new CompositeRuntimeTurnSettledPayloadNormalizer([
    new ClaudeStopHookPayloadNormalizer(hash),
    new CodexNativeTurnSettledPayloadNormalizer(hash),
    new OpenCodeTurnSettledPayloadNormalizer(hash),
  ]);
  const runtimeTurnSettledTargetResolver =
    deps.runtimeTurnSettledTargetResolver ??
    new TeamRuntimeTurnSettledTargetResolver({
      teamSource: configReaderForReadOnlySync,
      membersMetaStore: deps.membersMetaStore,
    });
  const reportToken = new HmacMemberWorkSyncReportTokenAdapter(storePaths);
  const watchdogCooldown = new TeamTaskStallJournalWorkSyncCooldown(deps.teamsBasePath);
  const toolActivityBusySignal = new MemberWorkSyncToolActivityBusySignal();
  const busySignals = [toolActivityBusySignal, ...(deps.extraBusySignals ?? [])];
  const busySignal =
    busySignals.length === 1
      ? toolActivityBusySignal
      : new CompositeMemberWorkSyncBusySignal(busySignals, deps.logger);
  const inboxNudge = new TeamInboxMemberWorkSyncNudgeSink(
    undefined,
    undefined,
    deps.resolveControlUrl
  );
  const useCaseDeps = {
    clock,
    hash,
    agendaSource,
    statusStore: store,
    reportStore: store,
    outboxStore: store,
    inboxNudge,
    watchdogCooldown,
    busySignal,
    ...(deps.proofMissingRecoveryGuard
      ? { proofMissingRecoveryGuard: deps.proofMissingRecoveryGuard }
      : {}),
    ...(deps.nudgeDeliveryWake ? { nudgeDeliveryWake: deps.nudgeDeliveryWake } : {}),
    ...(deps.reviewPickupDelivery ? { reviewPickupDelivery: deps.reviewPickupDelivery } : {}),
    ...(deps.reviewPickupEscalation ? { reviewPickupEscalation: deps.reviewPickupEscalation } : {}),
    reportToken,
    auditJournal,
    ...(deps.isTeamActive
      ? {
          lifecycle: {
            isTeamActive: deps.isTeamActive,
            ...(deps.isMemberActive ? { isMemberActive: deps.isMemberActive } : {}),
          },
        }
      : {}),
    logger: deps.logger,
  };
  const diagnosticsReader = new MemberWorkSyncDiagnosticsReader(useCaseDeps);
  const metricsReader = new MemberWorkSyncMetricsReader(useCaseDeps);
  const reporter = new MemberWorkSyncReporter(useCaseDeps);
  const reconciler = new MemberWorkSyncReconciler(useCaseDeps);
  const pendingReportReplayer = new MemberWorkSyncPendingReportIntentReplayer(useCaseDeps);
  const nudgeDispatcher = new MemberWorkSyncNudgeDispatcher(useCaseDeps);
  const emptyNudgeDispatchSummary = (): MemberWorkSyncNudgeDispatchSummary => ({
    claimed: 0,
    delivered: 0,
    superseded: 0,
    retryable: 0,
    terminal: 0,
  });
  const addNudgeDispatchSummaries = (
    left: MemberWorkSyncNudgeDispatchSummary,
    right: MemberWorkSyncNudgeDispatchSummary
  ): MemberWorkSyncNudgeDispatchSummary => ({
    claimed: left.claimed + right.claimed,
    delivered: left.delivered + right.delivered,
    superseded: left.superseded + right.superseded,
    retryable: left.retryable + right.retryable,
    terminal: left.terminal + right.terminal,
  });
  const filterNudgeDispatchReadyTeamNames = async (teamNames: string[]): Promise<string[]> => {
    const uniqueTeamNames = [...new Set(teamNames.map((name) => name.trim()).filter(Boolean))];
    if (!deps.canDispatchNudges) {
      return uniqueTeamNames;
    }

    const readyTeamNames: string[] = [];
    for (const teamName of uniqueTeamNames) {
      try {
        if (await deps.canDispatchNudges(teamName)) {
          readyTeamNames.push(teamName);
        }
      } catch (error) {
        deps.logger?.warn('member work sync nudge dispatch readiness check failed', {
          teamName,
          error: String(error),
        });
      }
    }
    return readyTeamNames;
  };
  const refreshBackgroundStaleStatuses = async (teamNames: string[]): Promise<void> => {
    const nowMs = clock.now().getTime();
    let refreshed = 0;
    for (const teamName of teamNames) {
      let memberNames: string[];
      try {
        memberNames = await agendaSource.loadActiveMemberNames(teamName);
      } catch (error) {
        deps.logger?.warn('member work sync background refresh member scan failed', {
          teamName,
          error: String(error),
        });
        continue;
      }

      for (const memberName of memberNames) {
        try {
          const status = await store.read({ teamName, memberName });
          if (status && !statusNeedsBackgroundRefresh(status, nowMs)) {
            continue;
          }
          await reconciler.execute(
            { teamName, memberName },
            {
              reconciledBy: 'queue',
              triggerReasons: [status ? 'manual_refresh' : 'startup_scan'],
            }
          );
          refreshed += 1;
        } catch (error) {
          deps.logger?.warn('member work sync background refresh failed', {
            teamName,
            memberName,
            error: String(error),
          });
        }
      }
    }

    if (refreshed > 0) {
      deps.logger?.debug('member work sync background stale refresh completed', { refreshed });
    }
  };
  const dispatchNudgesForReadyTeams = async (
    teamNames: string[],
    claimedBy: string,
    options: { refreshBackgroundStaleStatuses?: boolean } = {}
  ): Promise<MemberWorkSyncNudgeDispatchSummary> => {
    const readyTeamNames = await filterNudgeDispatchReadyTeamNames(teamNames);
    if (readyTeamNames.length === 0) {
      return emptyNudgeDispatchSummary();
    }
    const dispatchReadyNudges = () =>
      nudgeDispatcher.dispatchDue({
        teamNames: readyTeamNames,
        claimedBy,
      });
    const initialSummary = await dispatchReadyNudges();
    if (options.refreshBackgroundStaleStatuses !== false) {
      await refreshBackgroundStaleStatuses(readyTeamNames);
      return addNudgeDispatchSummaries(initialSummary, await dispatchReadyNudges());
    }
    return initialSummary;
  };
  const queue = new MemberWorkSyncEventQueue({
    reconcile: async (request, context: MemberWorkSyncReconcileContext) => {
      await reconciler.execute(request, context);
      if (context.isCancelled?.()) {
        return;
      }
      await dispatchNudgesForReadyTeams([request.teamName], `member-work-sync:${process.pid}`, {
        refreshBackgroundStaleStatuses: false,
      });
    },
    isTeamActive: deps.isTeamActive ?? (() => true),
    reconcileInactiveTeams: true,
    ...(deps.queueQuietWindowMs != null ? { quietWindowMs: deps.queueQuietWindowMs } : {}),
    auditJournal,
    logger: deps.logger,
  });
  const taskImpactResolver = new MemberWorkSyncTaskImpactResolver({
    taskReader: deps.taskReader,
    kanbanManager: deps.kanbanManager,
    activeMemberSource: agendaSource,
  });
  const router = new MemberWorkSyncTeamChangeRouter(
    agendaSource,
    queue,
    {
      materializeMember: (teamName, memberName) =>
        storePaths.ensureMemberWorkSyncDir(teamName, memberName),
    },
    taskImpactResolver
  );
  const runtimeTurnSettledIngestor = new RuntimeTurnSettledIngestor({
    eventStore: runtimeTurnSettledStore,
    normalizer: runtimeTurnSettledNormalizer,
    targetResolver: runtimeTurnSettledTargetResolver,
    reconcileQueue: {
      enqueueRuntimeTurnSettled: ({ teamName, memberName, event }) => {
        router.noteTeamChange({
          type: 'member-turn-settled',
          teamName,
          detail: JSON.stringify({
            memberName,
            sourceId: event.sourceId,
            provider: event.provider,
          }),
        });
      },
    },
    clock,
    auditJournal,
    logger: deps.logger,
  });
  const runtimeTurnSettledDrainScheduler = new RuntimeTurnSettledDrainScheduler({
    drain: () => runtimeTurnSettledIngestor.drainPending(),
    logger: deps.logger,
  });
  const nudgeDispatchScheduler = deps.listLifecycleActiveTeamNames
    ? new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: deps.listLifecycleActiveTeamNames,
        dispatchDue: (teamNames) =>
          dispatchNudgesForReadyTeams(teamNames, `member-work-sync:${process.pid}:scheduled`),
        logger: deps.logger,
      })
    : null;
  runtimeTurnSettledDrainScheduler.start();
  nudgeDispatchScheduler?.start();
  let disposePromise: Promise<void> | null = null;

  const readStatusWithStaleRefresh = async (
    request: MemberWorkSyncStatusRequest
  ): Promise<MemberWorkSyncStatus> => {
    const status = await diagnosticsReader.execute(request);
    const stalenessDiagnostics = getStatusStalenessDiagnostics(status, clock.now().getTime());
    if (stalenessDiagnostics.length === 0) {
      return status;
    }
    if (shouldRefreshStatusSynchronously(stalenessDiagnostics)) {
      try {
        return await reconciler.execute(request, {
          reconciledBy: 'request',
          triggerReasons: ['manual_refresh'],
        });
      } catch (error) {
        deps.logger?.warn('member work sync synchronous status refresh failed', {
          teamName: status.teamName,
          memberName: status.memberName,
          diagnostics: stalenessDiagnostics,
          error: String(error),
        });
      }
    }
    queue.enqueue({
      teamName: status.teamName,
      memberName: status.memberName,
      triggerReason: 'manual_refresh',
    });
    return {
      ...status,
      diagnostics: [...new Set([...status.diagnostics, ...stalenessDiagnostics])],
    };
  };

  const scheduleProofMissingRecovery = async (
    request: MemberWorkSyncProofMissingRecoveryScheduleRequest
  ): Promise<MemberWorkSyncProofMissingRecoveryScheduleResult> => {
    const teamName = request.teamName.trim();
    const memberName = request.memberName.trim();
    const originalMessageId = request.originalMessageId.trim();
    if (!teamName || !memberName || !originalMessageId) {
      return { scheduled: false, reason: 'invalid' };
    }

    const taskRefs = normalizeRecoveryTaskRefs(request.taskRefs);
    if (taskRefs.length === 0) {
      await auditJournal.append({
        timestamp: clock.now().toISOString(),
        teamName,
        memberName,
        event: 'proof_missing_recovery_suppressed',
        source: 'proof_missing_recovery_scheduler',
        reason: 'missing_task_refs',
        metadata: {
          originalMessageId,
        },
      });
      return { scheduled: false, reason: 'invalid' };
    }

    const intentKey = buildProofMissingRecoveryIntentKey(originalMessageId);
    const sinceIso = new Date(
      clock.now().getTime() - PROOF_MISSING_RECOVERY_RECENT_WINDOW_MS
    ).toISOString();
    const existing = await store.findRecentRecoveryByIntent?.({
      teamName,
      memberName,
      intentKey,
      sinceIso,
    });
    if (existing) {
      await auditJournal.append({
        timestamp: clock.now().toISOString(),
        teamName,
        memberName,
        event: 'proof_missing_recovery_coalesced',
        source: 'proof_missing_recovery_scheduler',
        reason: existing.status,
        metadata: {
          intentKey,
          originalMessageId,
          existingOutboxId: existing.id,
        },
      });
      return {
        scheduled: false,
        reason: 'coalesced_recent',
        intentKey,
        existingOutboxId: existing.id,
      };
    }

    await auditJournal.append({
      timestamp: clock.now().toISOString(),
      teamName,
      memberName,
      event: 'proof_missing_recovery_scheduled',
      source: 'proof_missing_recovery_scheduler',
      reason: request.reason?.trim() || 'protocol_proof_missing',
      taskRefs,
      metadata: {
        intentKey,
        originalMessageId,
      },
    });
    queue.enqueue({
      teamName,
      memberName,
      triggerReason: 'proof_missing_recovery',
      recovery: {
        kind: 'proof_missing',
        intentKey,
        originalMessageId,
        taskIds: taskRefs.map((taskRef) => taskRef.taskId),
      },
    });
    return { scheduled: true, reason: 'scheduled', intentKey };
  };

  return {
    getStatus: readStatusWithStaleRefresh,
    refreshStatus: (request) => reconciler.execute(request, { reconciledBy: 'request' }),
    getMetrics: (request) => metricsReader.execute(request),
    report: (request) => reporter.execute(request),
    scheduleProofMissingRecovery,
    noteTeamChange: (event) => {
      toolActivityBusySignal.noteTeamChange(event);
      router.noteTeamChange(event);
    },
    enqueueStartupScan: (teamNames) => router.enqueueStartupScan(teamNames),
    replayPendingReports: async (teamNames) => {
      const accumulator: MemberWorkSyncPendingReportReplaySummary = {
        processed: 0,
        accepted: 0,
        rejected: 0,
        superseded: 0,
      };
      for (const teamName of teamNames) {
        try {
          const summary = await pendingReportReplayer.replayTeam(teamName);
          accumulator.processed += summary.processed;
          accumulator.accepted += summary.accepted;
          accumulator.rejected += summary.rejected;
          accumulator.superseded += summary.superseded;
        } catch (error) {
          deps.logger?.warn('member work sync pending report replay failed', {
            teamName,
            error: String(error),
          });
        }
      }
      return accumulator;
    },
    dispatchDueNudges: (teamNames) =>
      dispatchNudgesForReadyTeams(teamNames, `member-work-sync:${process.pid}`),
    buildRuntimeTurnSettledHookSettings: async ({ provider }) =>
      runtimeTurnSettledSpool.buildHookSettings({ provider }),
    buildRuntimeTurnSettledEnvironment: async ({ provider }) =>
      runtimeTurnSettledSpool.buildEnvironment({ provider }),
    drainRuntimeTurnSettledEvents: () => runtimeTurnSettledIngestor.drainPending(),
    getQueueDiagnostics: () => queue.getDiagnostics(),
    dispose: () => {
      if (!disposePromise) {
        disposePromise = Promise.allSettled([
          runtimeTurnSettledDrainScheduler.dispose(),
          nudgeDispatchScheduler?.dispose(),
          queue.stop(),
        ]).then(() => undefined);
      }
      return disposePromise;
    },
  };
}
