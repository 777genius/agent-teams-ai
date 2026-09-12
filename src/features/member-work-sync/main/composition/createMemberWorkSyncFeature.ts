import {
  MemberWorkSyncDiagnosticsReader,
  MemberWorkSyncMetricsReader,
  MemberWorkSyncNudgeDispatcher,
  type MemberWorkSyncNudgeDispatchSummary,
  MemberWorkSyncPendingReportIntentReplayer,
  type MemberWorkSyncPendingReportReplaySummary,
  type MemberWorkSyncReconcileContext,
  MemberWorkSyncReconciler,
  type MemberWorkSyncRecoveryCommandResult,
  MemberWorkSyncRecoveryCommands,
  MemberWorkSyncReporter,
  MemberWorkSyncTeamOperationGate,
  MemberWorkSyncTeamQuiescedError,
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
import { createAlwaysCurrentJsonMemberWorkSyncPurgeLifecycle } from '../infrastructure/JsonMemberWorkSyncActiveStatePurger';
import { MemberWorkSyncEventQueue } from '../infrastructure/MemberWorkSyncEventQueue';
import { MemberWorkSyncNudgeDispatchScheduler } from '../infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import {
  createScheduledDispatchSignals,
  startScheduledDispatch,
} from '../infrastructure/memberWorkSyncScheduledDispatchLifetime';
import { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import { MemberWorkSyncToolActivityBusySignal } from '../infrastructure/MemberWorkSyncToolActivityBusySignal';
import { NodeHashAdapter } from '../infrastructure/NodeHashAdapter';
import { OpenCodeTurnSettledPayloadNormalizer } from '../infrastructure/OpenCodeTurnSettledPayloadNormalizer';
import { QuiescingMemberWorkSyncAuditJournal } from '../infrastructure/QuiescingMemberWorkSyncAuditJournal';
import { RuntimeTurnSettledDrainScheduler } from '../infrastructure/RuntimeTurnSettledDrainScheduler';
import { RuntimeTurnSettledSpoolInitializer } from '../infrastructure/RuntimeTurnSettledSpoolInitializer';
import { SystemClockAdapter } from '../infrastructure/SystemClockAdapter';

import { bindMemberWorkSyncUseCaseDeps } from './bindMemberWorkSyncUseCaseDeps';
import { createMemberWorkSyncPersistence } from './createMemberWorkSyncPersistence';
import {
  createMemberWorkSyncRestoreParticipant,
  type MemberWorkSyncRestoreParticipant,
} from './createMemberWorkSyncRestoreParticipant';
import { createUnsupportedMemberWorkSyncRuntimeTicketAdmission } from './createUnsupportedMemberWorkSyncRuntimeTicketAdmission';
import {
  buildProofMissingRecoveryIntentKey,
  normalizeRecoveryTaskRefs,
} from './memberWorkSyncFeatureContracts';
import {
  getStatusStalenessDiagnostics,
  statusNeedsBackgroundRefresh,
  uniqueMemberWorkSyncTeamNames,
} from './memberWorkSyncFeatureStatusRefresh';
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
  MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncTeamOperationAdmission,
  MemberWorkSyncUseCaseDeps,
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

export function createMemberWorkSyncFeature(deps: {
  teamsBasePath: string;
  lifecycleIdentity: ConstructorParameters<typeof HmacMemberWorkSyncReportTokenAdapter>[1];
  operationGate?: MemberWorkSyncTeamOperationGate;
  startBackground?: boolean;
  bindRestoreParticipant?: (participant: MemberWorkSyncRestoreParticipant) => void;
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
  /** Qualified D0 protocol-1 recovery allocation. Desktop wiring turns this on. */
  recoveryAllocation?: { enabled: boolean };
  recoveryProtocol?: { version: number };
  runtimeTicketAdmission?: MemberWorkSyncRuntimeTicketAdmissionPort;
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
  const operationGate = deps.operationGate ?? new MemberWorkSyncTeamOperationGate();
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
  const { store, jsonStore, reportJournal, authority } = createMemberWorkSyncPersistence({
    storePaths,
    auditJournal,
    lifecycleIdentity: deps.lifecycleIdentity,
    ...(deps.internalStorageBackend ? { internalStorageBackend: deps.internalStorageBackend } : {}),
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
  const reportToken = new HmacMemberWorkSyncReportTokenAdapter(storePaths, deps.lifecycleIdentity);
  deps.bindRestoreParticipant?.(
    createMemberWorkSyncRestoreParticipant(store, reportToken, storePaths)
  );
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
    reportJournal,
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
    ...(deps.recoveryAllocation
      ? { recoveryAllocation: deps.recoveryAllocation }
      : (deps.recoveryProtocol?.version ?? 0) >= 1
        ? { recoveryAllocation: { enabled: true } }
        : {}),
    ...(deps.recoveryProtocol ? { recoveryProtocol: deps.recoveryProtocol } : {}),
    ...(deps.runtimeTicketAdmission
      ? { runtimeTicketAdmission: deps.runtimeTicketAdmission }
      : (deps.recoveryProtocol?.version ?? 0) >= 2
        ? { runtimeTicketAdmission: createUnsupportedMemberWorkSyncRuntimeTicketAdmission() }
        : {}),
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
  const bindDeps = (
    teamName: string,
    admission: MemberWorkSyncTeamOperationAdmission,
    trackSettling?: (work: Promise<unknown>) => void
  ) =>
    bindMemberWorkSyncUseCaseDeps({
      base: useCaseDeps,
      teamName,
      admission,
      authority,
      ...(trackSettling ? { trackSettling } : {}),
    });
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
    bound: MemberWorkSyncUseCaseDeps,
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
        await new MemberWorkSyncReconciler(bound).execute(
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
  const { createScheduledTeamDispatchSignal, cancelScheduledTeamDispatch } =
    createScheduledDispatchSignals();
  const dispatchNudgesForAdmittedTeam = async (
    teamName: string,
    claimedBy: string,
    admission: MemberWorkSyncTeamOperationAdmission,
    options: {
      refreshBackgroundStaleStatuses?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<MemberWorkSyncNudgeDispatchSummary> => {
    const bound = bindDeps(teamName, admission);
    if (!(await isNudgeDispatchReady(teamName, options.signal)) || options.signal?.aborted) {
      if (options.refreshBackgroundStaleStatuses !== false && !options.signal?.aborted) {
        await refreshBackgroundStaleStatuses(teamName, bound, options.signal);
      }
      return emptyNudgeDispatchSummary();
    }
    const dispatchReadyNudges = (): Promise<MemberWorkSyncNudgeDispatchSummary> =>
      new MemberWorkSyncNudgeDispatcher(bound).dispatchDue({
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
      await refreshBackgroundStaleStatuses(teamName, bound, options.signal);
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
      trackSettling?: (work: Promise<unknown>) => void;
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
          dispatchNudgesForAdmittedTeam(
            teamName,
            claimedBy,
            {
              trackSettling: (work) => {
                options.trackSettling?.(work);
                return admission.trackSettling(work);
              },
            },
            {
              ...(options.refreshBackgroundStaleStatuses != null
                ? { refreshBackgroundStaleStatuses: options.refreshBackgroundStaleStatuses }
                : {}),
              ...(scheduledSignal?.signal
                ? { signal: scheduledSignal.signal }
                : options.signal
                  ? { signal: options.signal }
                  : {}),
            }
          )
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
          await new MemberWorkSyncReconciler(bindDeps(request.teamName, admission)).execute(
            request,
            context
          );
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
        : jsonStore.purgeActiveState(
            teamName,
            createAlwaysCurrentJsonMemberWorkSyncPurgeLifecycle()
          ),
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
          startScheduledDispatch((trackSettling) =>
            dispatchNudgesForReadyTeams(teamNames, `member-work-sync:${process.pid}:scheduled`, {
              signal,
              scheduled: true,
              trackSettling,
            })
          ),
        observeDue: async (teamName) => {
          await operationGate.run(teamName, (admission) =>
            refreshBackgroundStaleStatuses(teamName, bindDeps(teamName, admission))
          );
        },
        logger: deps.logger,
      })
    : null;
  let disposePromise: Promise<void> | null = null;
  let backgroundStarted = false;
  const startBackground = (): void => {
    if (backgroundStarted || disposePromise) return;
    backgroundStarted = true;
    runtimeTurnSettledDrainScheduler.start();
    nudgeDispatchScheduler?.start();
  };
  if (deps.startBackground !== false) startBackground();

  const readStatusWithStaleRefresh = async (
    request: MemberWorkSyncStatusRequest,
    bound: MemberWorkSyncUseCaseDeps
  ): Promise<MemberWorkSyncStatus> => {
    const status = await new MemberWorkSyncDiagnosticsReader(bound).execute(request);
    const stalenessDiagnostics = getStatusStalenessDiagnostics(status, clock.now().getTime());
    if (stalenessDiagnostics.length === 0) {
      return status;
    }
    if (
      stalenessDiagnostics.some((diagnostic) => diagnostic !== 'caught_up_stale_refresh_enqueued')
    ) {
      try {
        return await new MemberWorkSyncReconciler(bound).execute(request, {
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
  const runRecovery = (
    teamName: string,
    work: (commands: MemberWorkSyncRecoveryCommands) => Promise<MemberWorkSyncRecoveryCommandResult>
  ) =>
    operationGate.run(teamName, async (admission) => {
      const result = await work(new MemberWorkSyncRecoveryCommands(bindDeps(teamName, admission)));
      if (!result.ok) {
        throw new Error(result.code);
      }
      return result.status;
    });
  return {
    startBackground,
    getStatus: (request) =>
      operationGate.run(request.teamName, (admission) =>
        readStatusWithStaleRefresh(request, bindDeps(request.teamName, admission))
      ),
    refreshStatus: (request) =>
      operationGate.run(request.teamName, (admission) =>
        new MemberWorkSyncReconciler(bindDeps(request.teamName, admission)).execute(request, {
          reconciledBy: 'request',
        })
      ),
    getMetrics: (request) =>
      operationGate.run(request.teamName, (admission) =>
        new MemberWorkSyncMetricsReader(bindDeps(request.teamName, admission)).execute(request)
      ),
    report: (request) =>
      operationGate.run(request.teamName, (admission) =>
        new MemberWorkSyncReporter(bindDeps(request.teamName, admission)).execute(request)
      ),
    scheduleProofMissingRecovery: (request) =>
      operationGate.run(request.teamName, () => scheduleProofMissingRecovery(request)),
    prepareTeamDeletion: (teamName, deletionIdentityId, options) =>
      deletionCoordinator.prepare(teamName, deletionIdentityId, options),
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
          const summary = await operationGate.run(teamName, (admission) =>
            new MemberWorkSyncPendingReportIntentReplayer(bindDeps(teamName, admission)).replayTeam(
              teamName
            )
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
    getSchedulerHealth: () =>
      nudgeDispatchScheduler?.getHealth() ?? {
        pendingDiscovery: 0,
        retainedDispatches: 0,
        lastDiscoveryAt: null,
        discoveryCapacityExhausted: false,
      },
    stopAutoResume: (input) => runRecovery(input.teamName, (commands) => commands.stop(input)),
    resumeAutoResume: (input) => runRecovery(input.teamName, (commands) => commands.resume(input)),
    continueManually: async (input) => {
      const status = await runRecovery(input.teamName, (commands) =>
        commands.continueManually(input)
      );
      await dispatchNudgesForReadyTeams(
        [input.teamName],
        `member-work-sync:${process.pid}:continue`
      );
      return status;
    },
    recordStallObservation: async (input) => {
      await operationGate.run(input.teamName, async (admission) => {
        await new MemberWorkSyncRecoveryCommands(
          bindDeps(input.teamName, admission)
        ).recordStallObservation(input);
      });
    },
    dispose: () => {
      if (!disposePromise) {
        acceptsRuntimeTurnSettledReconcile = false;
        disposePromise = Promise.allSettled([
          runtimeTurnSettledDrainScheduler.dispose(),
          nudgeDispatchScheduler?.dispose(),
          operationGate.awaitIdle(),
        ])
          .then(() => queue.stop())
          .then(() => undefined);
      }
      return disposePromise;
    },
  };
}
