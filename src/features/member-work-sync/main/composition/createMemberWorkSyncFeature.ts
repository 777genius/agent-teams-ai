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
  MemberWorkSyncTeamOperationGate,
  MemberWorkSyncTeamQuiescedError,
  normalizeMemberWorkSyncTeamOperationKey,
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
import { MemberWorkSyncEventQueue } from '../infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncNudgeDispatchScheduler } from '../infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { MemberWorkSyncSqliteImporter } from '../infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import { MemberWorkSyncToolActivityBusySignal } from '../infrastructure/MemberWorkSyncToolActivityBusySignal';
import { NodeHashAdapter } from '../infrastructure/NodeHashAdapter';
import { OpenCodeTurnSettledPayloadNormalizer } from '../infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { QuiescingMemberWorkSyncAuditJournal } from '../infrastructure/QuiescingMemberWorkSyncAuditJournal';
import { RuntimeTurnSettledDrainScheduler } from '../infrastructure/RuntimeTurnSettledDrainScheduler';
import { RuntimeTurnSettledSpoolInitializer } from '../infrastructure/RuntimeTurnSettledSpoolInitializer';
import { SqliteMemberWorkSyncStore } from '../infrastructure/SqliteMemberWorkSyncStore';
import { SystemClockAdapter } from '../infrastructure/SystemClockAdapter';

import {
  buildProofMissingRecoveryIntentKey,
  normalizeRecoveryTaskRefs,
} from './memberWorkSyncFeatureContracts';
import {
  CAUGHT_UP_STATUS_MAX_AGE_MS,
  getAcceptedWorkLeaseStaleness,
  getReportTokenStaleness,
  isEmptyAgendaStaleState,
  STALE_STATUS_MAX_AGE_MS,
} from './memberWorkSyncStatusRefreshPolicy';
import { MemberWorkSyncTeamDeletionCoordinator } from './MemberWorkSyncTeamDeletionCoordinator';

export {
  buildMemberWorkSyncRuntimeTurnSettledEnvironment,
  type MemberWorkSyncFeatureFacade,
  type MemberWorkSyncProofMissingRecoveryScheduleRequest,
  type MemberWorkSyncProofMissingRecoveryScheduleResult,
} from './memberWorkSyncFeatureContracts';

import type { MemberWorkSyncStatus, MemberWorkSyncStatusRequest } from '../../contracts';
import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncLoggerPort,
  MemberWorkSyncNudgeDeliveryWakePort,
  MemberWorkSyncProofMissingRecoveryGuardPort,
  MemberWorkSyncReviewPickupDeliveryPort,
  MemberWorkSyncReviewPickupEscalationPort,
  MemberWorkSyncTeamOperationAdmission,
} from '../../core/application';
import type {
  MemberWorkSyncFeatureFacade,
  MemberWorkSyncProofMissingRecoveryScheduleRequest,
  MemberWorkSyncProofMissingRecoveryScheduleResult,
} from './memberWorkSyncFeatureContracts';
import type { InternalStorageMemberWorkSyncBackend } from '@features/internal-storage/main';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';

const PROOF_MISSING_RECOVERY_RECENT_WINDOW_MS = 10 * 60_000;

// Keep runtime-settled and deletion coordination behind the same feature lifecycle boundary.
function statusNeedsBackgroundRefresh(status: MemberWorkSyncStatus, nowMs: number): boolean {
  if (getReportTokenStaleness(status, nowMs) !== null || isEmptyAgendaStaleState(status)) {
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

function uniqueMemberWorkSyncTeamNames(teamNames: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of teamNames) {
    const teamName = candidate.trim();
    if (!teamName) {
      continue;
    }
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    if (seen.has(teamKey)) {
      continue;
    }
    seen.add(teamKey);
    unique.push(teamName);
  }
  return unique;
}

export function createMemberWorkSyncFeature(deps: {
  teamsBasePath: string;
  configFileAccess?: (configPath: string) => Promise<void>;
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
  priorityBusySignals?: MemberWorkSyncBusySignalPort[];
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
  const operationGate = new MemberWorkSyncTeamOperationGate();
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
  const auditJournal = new QuiescingMemberWorkSyncAuditJournal(
    new FileMemberWorkSyncAuditJournal(storePaths, deps.logger)
  );
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
        jsonStore,
        {
          gateway: deps.internalStorageBackend.gateway,
          paths: storePaths,
          fallbackRequiresReplica: deps.internalStorageBackend.fallbackRequiresReplica ?? false,
          logger: deps.logger,
        }
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
  const busySignal = CompositeMemberWorkSyncBusySignal.compose(toolActivityBusySignal, deps);
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
  const isNudgeDispatchReady = async (teamName: string, signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) {
      return false;
    }
    if (!deps.canDispatchNudges) {
      return true;
    }

    try {
      const ready = await deps.canDispatchNudges(teamName);
      return signal?.aborted ? false : ready;
    } catch (error) {
      if (!signal?.aborted) {
        deps.logger?.warn('member work sync nudge dispatch readiness check failed', {
          teamName,
          error: String(error),
        });
      }
      return false;
    }
  };
  const refreshBackgroundStaleStatuses = async (
    teamName: string,
    signal?: AbortSignal
  ): Promise<void> => {
    const nowMs = clock.now().getTime();
    let refreshed = 0;
    if (signal?.aborted) {
      return;
    }
    let memberNames: string[];
    try {
      memberNames = await agendaSource.loadActiveMemberNames(teamName);
      if (signal?.aborted) {
        return;
      }
    } catch (error) {
      deps.logger?.warn('member work sync background refresh member scan failed', {
        teamName,
        error: String(error),
      });
      return;
    }

    for (const memberName of memberNames) {
      if (signal?.aborted) {
        break;
      }
      try {
        const status = await store.read({ teamName, memberName });
        if (signal?.aborted) {
          break;
        }
        if (status && !statusNeedsBackgroundRefresh(status, nowMs)) {
          continue;
        }
        await reconciler.execute(
          { teamName, memberName },
          {
            reconciledBy: 'queue',
            triggerReasons: [status ? 'manual_refresh' : 'startup_scan'],
            ...(signal ? { isCancelled: () => signal.aborted } : {}),
          }
        );
        if (signal?.aborted) {
          break;
        }
        refreshed += 1;
      } catch (error) {
        deps.logger?.warn('member work sync background refresh failed', {
          teamName,
          memberName,
          error: String(error),
        });
      }
    }

    if (refreshed > 0) {
      deps.logger?.debug('member work sync background stale refresh completed', { refreshed });
    }
  };
  const scheduledDispatchControllersByTeam = new Map<string, Set<AbortController>>();
  const createScheduledTeamDispatchSignal = (
    teamName: string,
    schedulerSignal?: AbortSignal
  ): { signal: AbortSignal; release(): void } => {
    const controller = new AbortController();
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const controllers = scheduledDispatchControllersByTeam.get(teamKey) ?? new Set();
    controllers.add(controller);
    scheduledDispatchControllersByTeam.set(teamKey, controllers);
    const abortForScheduler = (): void => controller.abort();
    if (schedulerSignal?.aborted) {
      controller.abort();
    } else {
      schedulerSignal?.addEventListener('abort', abortForScheduler, { once: true });
    }

    return {
      signal: controller.signal,
      release: () => {
        schedulerSignal?.removeEventListener('abort', abortForScheduler);
        controllers.delete(controller);
        if (controllers.size === 0) {
          scheduledDispatchControllersByTeam.delete(teamKey);
        }
      },
    };
  };
  const cancelScheduledTeamDispatch = (teamName: string): void => {
    for (const controller of scheduledDispatchControllersByTeam.get(
      normalizeMemberWorkSyncTeamOperationKey(teamName)
    ) ?? []) {
      controller.abort();
    }
  };
  const dispatchNudgesForAdmittedTeam = async (
    teamName: string,
    claimedBy: string,
    admission: MemberWorkSyncTeamOperationAdmission,
    options: {
      refreshBackgroundStaleStatuses?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<MemberWorkSyncNudgeDispatchSummary> => {
    if (!(await isNudgeDispatchReady(teamName, options.signal)) || options.signal?.aborted) {
      return emptyNudgeDispatchSummary();
    }
    const dispatchReadyNudges = (): Promise<MemberWorkSyncNudgeDispatchSummary> =>
      nudgeDispatcher.dispatchDue({
        teamNames: [teamName],
        claimedBy,
        ...(options.signal ? { signal: options.signal } : {}),
        trackSettlingWork: (_settlingTeamName, work) => admission.trackSettling(work),
      });
    const initialSummary = await dispatchReadyNudges();
    if (options.signal?.aborted) {
      return initialSummary;
    }
    if (options.refreshBackgroundStaleStatuses !== false) {
      await refreshBackgroundStaleStatuses(teamName, options.signal);
      if (options.signal?.aborted) {
        return initialSummary;
      }
      return addNudgeDispatchSummaries(initialSummary, await dispatchReadyNudges());
    }
    return initialSummary;
  };
  const dispatchNudgesForReadyTeams = async (
    teamNames: string[],
    claimedBy: string,
    options: {
      refreshBackgroundStaleStatuses?: boolean;
      signal?: AbortSignal;
      scheduled?: boolean;
    } = {}
  ): Promise<MemberWorkSyncNudgeDispatchSummary> => {
    let summary = emptyNudgeDispatchSummary();
    for (const teamName of uniqueMemberWorkSyncTeamNames(teamNames)) {
      if (options.signal?.aborted) {
        break;
      }
      const scheduledSignal = options.scheduled
        ? createScheduledTeamDispatchSignal(teamName, options.signal)
        : null;
      try {
        const teamSummary = await operationGate.run(teamName, (admission) =>
          dispatchNudgesForAdmittedTeam(teamName, claimedBy, admission, {
            ...(options.refreshBackgroundStaleStatuses != null
              ? { refreshBackgroundStaleStatuses: options.refreshBackgroundStaleStatuses }
              : {}),
            ...(scheduledSignal?.signal
              ? { signal: scheduledSignal.signal }
              : options.signal
                ? { signal: options.signal }
                : {}),
          })
        );
        summary = addNudgeDispatchSummaries(summary, teamSummary);
      } catch (error) {
        if (!(error instanceof MemberWorkSyncTeamQuiescedError)) {
          deps.logger?.warn('member work sync team nudge dispatch failed', {
            teamName,
            error: String(error),
          });
        }
      } finally {
        scheduledSignal?.release();
      }
    }
    return summary;
  };
  const queue = new MemberWorkSyncEventQueue({
    reconcile: async (request, context: MemberWorkSyncReconcileContext) => {
      try {
        await operationGate.run(request.teamName, async (admission) => {
          await reconciler.execute(request, context);
          if (context.isCancelled?.()) {
            return;
          }
          await dispatchNudgesForAdmittedTeam(
            request.teamName,
            `member-work-sync:${process.pid}`,
            admission,
            { refreshBackgroundStaleStatuses: false }
          );
        });
      } catch (error) {
        if (!(error instanceof MemberWorkSyncTeamQuiescedError)) {
          throw error;
        }
      }
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
  const deletionCoordinator = new MemberWorkSyncTeamDeletionCoordinator({
    teamsBasePath: deps.teamsBasePath,
    ...(deps.configFileAccess ? { configFileAccess: deps.configFileAccess } : {}),
    beginOperationGateQuiesce: (teamName) => operationGate.beginTeamQuiesce(teamName),
    awaitOperationGateIdle: (teamName) => operationGate.awaitTeamIdle(teamName),
    resumeOperationGate: (teamName) => operationGate.resumeTeam(teamName),
    cancelScheduledDispatch: cancelScheduledTeamDispatch,
    beginAuditQuiesce: (teamName) => auditJournal.beginTeamQuiesce(teamName),
    awaitAuditIdle: (teamName) => auditJournal.awaitTeamIdle(teamName),
    resumeAudit: (teamName) => auditJournal.resumeTeam(teamName),
    quiesceRouter: (teamName) => router.quiesceTeam(teamName),
    resumeRouter: (teamName) => router.resumeTeam(teamName),
    enqueueStartupScan: (teamNames) => router.enqueueStartupScan(teamNames),
    purgeTeam: (teamName, deletionIdentityId) =>
      store instanceof BackendSelectingMemberWorkSyncStore
        ? store.purgeTeam(teamName, deletionIdentityId)
        : Promise.resolve(),
  });
  let acceptsRuntimeTurnSettledReconcile = true;
  const runtimeTurnSettledIngestor = new RuntimeTurnSettledIngestor({
    eventStore: runtimeTurnSettledStore,
    normalizer: runtimeTurnSettledNormalizer,
    targetResolver: runtimeTurnSettledTargetResolver,
    reconcileQueue: {
      enqueueRuntimeTurnSettled: ({ teamName, memberName }) =>
        acceptsRuntimeTurnSettledReconcile &&
        queue.enqueue({
          teamName,
          memberName,
          triggerReason: 'turn_settled',
        }),
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
        dispatchDue: (teamNames, signal) =>
          dispatchNudgesForReadyTeams(teamNames, `member-work-sync:${process.pid}:scheduled`, {
            signal,
            scheduled: true,
          }),
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
    getStatus: (request) =>
      operationGate.run(request.teamName, () => readStatusWithStaleRefresh(request)),
    refreshStatus: (request) =>
      operationGate.run(request.teamName, () =>
        reconciler.execute(request, { reconciledBy: 'request' })
      ),
    getMetrics: (request) =>
      operationGate.run(request.teamName, () => metricsReader.execute(request)),
    report: (request) => operationGate.run(request.teamName, () => reporter.execute(request)),
    scheduleProofMissingRecovery: (request) =>
      operationGate.run(request.teamName, () => scheduleProofMissingRecovery(request)),
    prepareTeamDeletion: (teamName, deletionIdentityId) =>
      deletionCoordinator.prepare(teamName, deletionIdentityId),
    completeTeamDeletion: (teamName) => deletionCoordinator.complete(teamName),
    resumeTeam: (teamName) => deletionCoordinator.resume(teamName),
    noteTeamChange: (event) => {
      toolActivityBusySignal.noteTeamChange(event);
      if (deletionCoordinator.interceptTeamChange(event)) return;
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
          const summary = await operationGate.run(teamName, () =>
            pendingReportReplayer.replayTeam(teamName)
          );
          accumulator.processed += summary.processed;
          accumulator.accepted += summary.accepted;
          accumulator.rejected += summary.rejected;
          accumulator.superseded += summary.superseded;
        } catch (error) {
          if (!(error instanceof MemberWorkSyncTeamQuiescedError)) {
            deps.logger?.warn('member work sync pending report replay failed', {
              teamName,
              error: String(error),
            });
          }
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
        // Close admission synchronously. An active drain may outlive the
        // scheduler's bounded dispose wait, so it must not acknowledge a
        // spool item after queue.stop() has discarded the accepted work.
        acceptsRuntimeTurnSettledReconcile = false;
        disposePromise = Promise.allSettled([
          runtimeTurnSettledDrainScheduler.dispose(),
          nudgeDispatchScheduler?.dispose(),
        ])
          .then(() => queue.stop())
          .then(() => undefined);
      }
      return disposePromise;
    },
  };
}
