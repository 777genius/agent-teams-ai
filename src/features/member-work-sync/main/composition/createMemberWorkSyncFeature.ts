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
import { ClaudeStopHookPayloadNormalizer } from '../infrastructure/ClaudeStopHookPayloadNormalizer';
import { CodexNativeTurnSettledPayloadNormalizer } from '../infrastructure/CodexNativeTurnSettledPayloadNormalizer';
import { CompositeMemberWorkSyncBusySignal } from '../infrastructure/CompositeMemberWorkSyncBusySignal';
import { CompositeRuntimeTurnSettledPayloadNormalizer } from '../infrastructure/CompositeRuntimeTurnSettledPayloadNormalizer';
import { FileMemberWorkSyncAuditJournal } from '../infrastructure/FileMemberWorkSyncAuditJournal';
import { FileRuntimeTurnSettledEventStore } from '../infrastructure/FileRuntimeTurnSettledEventStore';
import { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import { JsonMemberWorkSyncStore } from '../infrastructure/JsonMemberWorkSyncStore';
import {
  MemberWorkSyncEventQueue,
  type MemberWorkSyncQueueDiagnostics,
} from '../infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncNudgeDispatchScheduler } from '../infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import { MemberWorkSyncToolActivityBusySignal } from '../infrastructure/MemberWorkSyncToolActivityBusySignal';
import { NodeHashAdapter } from '../infrastructure/NodeHashAdapter';
import { OpenCodeTurnSettledPayloadNormalizer } from '../infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { RuntimeTurnSettledDrainScheduler } from '../infrastructure/RuntimeTurnSettledDrainScheduler';
import { RuntimeTurnSettledSpoolInitializer } from '../infrastructure/RuntimeTurnSettledSpoolInitializer';
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
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import type { TeamChangeEvent } from '@shared/types';

const STALE_STATUS_MAX_AGE_MS = 2 * 60_000;
const PROOF_MISSING_RECOVERY_RECENT_WINDOW_MS = 10 * 60_000;

function getStatusStalenessDiagnostics(status: MemberWorkSyncStatus, nowMs: number): string[] {
  const diagnostics: string[] = [];
  const evaluatedAtMs = Date.parse(status.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    diagnostics.push('status_evaluated_at_invalid');
  } else if (
    status.agenda.items.length > 0 &&
    ['needs_sync', 'still_working', 'blocked'].includes(status.state) &&
    nowMs - evaluatedAtMs > STALE_STATUS_MAX_AGE_MS
  ) {
    diagnostics.push('status_stale_refresh_enqueued');
  }

  const reportExpiresAtMs = Date.parse(status.report?.expiresAt ?? '');
  if (
    status.report?.accepted &&
    Number.isFinite(reportExpiresAtMs) &&
    reportExpiresAtMs <= nowMs &&
    (status.state === 'still_working' || status.state === 'blocked')
  ) {
    diagnostics.push('accepted_report_lease_expired_refresh_enqueued');
  }

  return [...new Set(diagnostics)];
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
  const store = new JsonMemberWorkSyncStore(storePaths, {
    auditJournal,
    logger: deps.logger,
  });
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
    ...(deps.isTeamActive ? { lifecycle: { isTeamActive: deps.isTeamActive } } : {}),
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
  const filterNudgeDispatchReadyTeamNames = async (teamNames: string[]): Promise<string[]> => {
    const uniqueTeamNames = [...new Set(teamNames.map((name) => name.trim()).filter(Boolean))];
    if (!deps.canDispatchNudges) {
      return uniqueTeamNames;
    }

    const readiness = await Promise.all(
      uniqueTeamNames.map(async (teamName) => {
        try {
          return { teamName, ready: await deps.canDispatchNudges!(teamName) };
        } catch (error) {
          deps.logger?.warn('member work sync nudge dispatch readiness check failed', {
            teamName,
            error: String(error),
          });
          return { teamName, ready: false };
        }
      })
    );
    return readiness.filter((item) => item.ready).map((item) => item.teamName);
  };
  const dispatchNudgesForReadyTeams = async (
    teamNames: string[],
    claimedBy: string
  ): Promise<MemberWorkSyncNudgeDispatchSummary> => {
    const readyTeamNames = await filterNudgeDispatchReadyTeamNames(teamNames);
    if (readyTeamNames.length === 0) {
      return emptyNudgeDispatchSummary();
    }
    return nudgeDispatcher.dispatchDue({
      teamNames: readyTeamNames,
      claimedBy,
    });
  };
  const queue = new MemberWorkSyncEventQueue({
    reconcile: async (request, context: MemberWorkSyncReconcileContext) => {
      await reconciler.execute(request, context);
      await dispatchNudgesForReadyTeams([request.teamName], `member-work-sync:${process.pid}`);
    },
    isTeamActive: deps.isTeamActive ?? (() => true),
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

  const readStatusWithStaleRefresh = async (
    request: MemberWorkSyncStatusRequest
  ): Promise<MemberWorkSyncStatus> => {
    const status = await diagnosticsReader.execute(request);
    const stalenessDiagnostics = getStatusStalenessDiagnostics(status, clock.now().getTime());
    if (stalenessDiagnostics.length === 0) {
      return status;
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
      const summaries = await Promise.allSettled(
        teamNames.map((teamName) => pendingReportReplayer.replayTeam(teamName))
      );
      return summaries.reduce<MemberWorkSyncPendingReportReplaySummary>(
        (accumulator, summary) => {
          if (summary.status !== 'fulfilled') {
            return accumulator;
          }
          accumulator.processed += summary.value.processed;
          accumulator.accepted += summary.value.accepted;
          accumulator.rejected += summary.value.rejected;
          accumulator.superseded += summary.value.superseded;
          return accumulator;
        },
        { processed: 0, accepted: 0, rejected: 0, superseded: 0 }
      );
    },
    dispatchDueNudges: (teamNames) =>
      dispatchNudgesForReadyTeams(teamNames, `member-work-sync:${process.pid}`),
    buildRuntimeTurnSettledHookSettings: async ({ provider }) =>
      runtimeTurnSettledSpool.buildHookSettings({ provider }),
    buildRuntimeTurnSettledEnvironment: async ({ provider }) =>
      runtimeTurnSettledSpool.buildEnvironment({ provider }),
    drainRuntimeTurnSettledEvents: () => runtimeTurnSettledIngestor.drainPending(),
    getQueueDiagnostics: () => queue.getDiagnostics(),
    dispose: async () => {
      runtimeTurnSettledDrainScheduler.dispose();
      await Promise.allSettled([queue.stop(), nudgeDispatchScheduler?.dispose()]);
    },
  };
}
