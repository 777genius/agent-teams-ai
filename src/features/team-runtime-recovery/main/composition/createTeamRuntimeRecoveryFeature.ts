import {
  CancelRuntimeRecoveries,
  CancelStaleRecoveries,
  DispatchDueRecoveries,
  ObserveRecoveryOutcome,
  ObserveRuntimeFailure,
  type RuntimeRecoveryConfigPort,
} from '../../core/application';
import { normalizeTeamRuntimeRecoveryConfig } from '../../core/domain';
import {
  RuntimeRecoveryNotificationAdapter,
  RuntimeRecoverySignalAdapter,
  RuntimeRecoveryTargetAdapter,
  TeamInboxRuntimeRecoveryDeliveryAdapter,
} from '../adapters';
import {
  JsonTeamRuntimeRecoveryRepository,
  NodeRuntimeRecoveryHash,
  SystemRuntimeRecoveryClock,
  TeamRuntimeRecoveryScheduler,
  TeamRuntimeRecoveryStorePaths,
} from '../infrastructure';

import type { LeadRuntimeFailureObservation } from '@main/services/team/TeamProvisioningService';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';
import type {
  InboxMessage,
  MemberRuntimeAdvisory,
  SendMessageRequest,
  SendMessageResult,
  TeamAgentRuntimeSnapshot,
  TeamChangeEvent,
  TeamTaskWithKanban,
} from '@shared/types';

const SCAN_DEBOUNCE_MS = 250;

interface RelayResult {
  kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
  relayed: number;
  diagnostics?: string[];
  lastDelivery?: {
    delivered?: boolean;
    accepted?: boolean;
    responsePending?: boolean;
    responseState?: string;
    reason?: string;
  };
}

export interface TeamRuntimeRecoveryFeatureFacade {
  start(): void;
  noteTeamChange(event: TeamChangeEvent): void;
  observeLeadFailure(failure: LeadRuntimeFailureObservation): void;
  cancelTeam(teamName: string, reason: string): Promise<number>;
  cancelAll(reason: string): Promise<number>;
  dispose(): Promise<void>;
}

export function createTeamRuntimeRecoveryFeature(deps: {
  teamsBasePath: string;
  configManager: {
    getConfig(): {
      teamRuntimeRecovery?: {
        transientErrorsEnabled: boolean;
        rateLimitsEnabled: boolean;
        initialDelaySeconds: number;
        maxAttempts: number;
      };
    };
    onConfigChanged(listener: (section: string) => void): () => void;
  };
  getCurrentContextId(): string;
  listActiveTeamNames(): Promise<string[]>;
  isTeamActive(teamName: string): Promise<boolean>;
  getRuntimeState(teamName: string): Promise<{ isAlive: boolean; runId: string | null }>;
  getRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
  getLeadName(teamName: string): Promise<string | null>;
  getTeamDisplayName(teamName: string): Promise<string>;
  getInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
  inboxWriter: {
    sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult>;
  };
  relay(
    teamName: string,
    memberName: string,
    options: { source: 'manual'; onlyMessageId: string }
  ): Promise<RelayResult>;
  getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null>;
  getMemberAdvisory(
    teamName: string,
    memberName: string,
    options?: { observedAfterMs?: number | null }
  ): Promise<MemberRuntimeAdvisory | null>;
  getOpenCodeBusyStatus(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    taskRefs?: Array<{ taskId: string; displayId: string; teamName: string }>;
  }): Promise<{ busy: boolean; reason?: string; retryAfterIso?: string }>;
  addNotification(payload: TeamNotificationPayload): Promise<unknown>;
  logger?: {
    debug(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
}): TeamRuntimeRecoveryFeatureFacade {
  const clock = new SystemRuntimeRecoveryClock();
  const hash = new NodeRuntimeRecoveryHash();
  const repository = new JsonTeamRuntimeRecoveryRepository(
    new TeamRuntimeRecoveryStorePaths(deps.teamsBasePath)
  );
  const config: RuntimeRecoveryConfigPort = {
    getConfig: () =>
      normalizeTeamRuntimeRecoveryConfig(deps.configManager.getConfig().teamRuntimeRecovery),
  };
  const notifications = new RuntimeRecoveryNotificationAdapter({
    add: deps.addNotification,
    getTeamDisplayName: deps.getTeamDisplayName,
    logger: deps.logger,
  });
  const delivery = new TeamInboxRuntimeRecoveryDeliveryAdapter({
    inboxReader: { getMessagesFor: deps.getInboxMessages },
    inboxWriter: deps.inboxWriter,
    relay: deps.relay,
    getLeadName: deps.getLeadName,
  });
  const target = new RuntimeRecoveryTargetAdapter({
    config,
    now: () => clock.now(),
    getCurrentContextId: deps.getCurrentContextId,
    getRuntimeState: deps.getRuntimeState,
    getRuntimeSnapshot: deps.getRuntimeSnapshot,
    getLeadName: deps.getLeadName,
    getInboxMessages: deps.getInboxMessages,
    getTask: deps.getTask,
    getMemberAdvisory: deps.getMemberAdvisory,
    getOpenCodeBusyStatus: deps.getOpenCodeBusyStatus,
  });
  const observe = new ObserveRuntimeFailure({
    clock,
    hash,
    config,
    repository,
    notifications,
  });
  const outcomes = new ObserveRecoveryOutcome({ clock, repository, notifications });
  const cancel = new CancelRuntimeRecoveries({ clock, repository, notifications });
  const dispatcher = new DispatchDueRecoveries({
    clock,
    hash,
    config,
    repository,
    target,
    delivery,
    notifications,
    logger: deps.logger,
  });
  const cancelStale = new CancelStaleRecoveries({
    repository,
    target,
    cancel,
    delivery,
    logger: deps.logger,
  });
  const signals = new RuntimeRecoverySignalAdapter({
    observe,
    getCurrentContextId: deps.getCurrentContextId,
    getRuntimeSnapshot: deps.getRuntimeSnapshot,
    getLeadName: deps.getLeadName,
    getInboxMessages: deps.getInboxMessages,
  });
  const scheduler = new TeamRuntimeRecoveryScheduler({
    repository,
    listActiveTeamNames: deps.listActiveTeamNames,
    dispatch: (teamNames) => dispatcher.execute({ teamNames, claimedBy: `desktop-${process.pid}` }),
    expireUnknownOutcomes: (teamNames) => outcomes.expireUnknownOutcomes(teamNames),
    logger: deps.logger,
  });
  const scanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scansInFlight = new Map<string, Promise<void>>();
  let disposed = false;

  const reconcileOutcomes = async (teamName: string): Promise<void> => {
    const state = await repository.read(teamName);
    const awaiting = state.jobs.filter((job) => job.status === 'awaiting_outcome');
    if (awaiting.length === 0) return;
    const leadName = await deps.getLeadName(teamName);
    const leadMessages = leadName ? await deps.getInboxMessages(teamName, leadName) : [];
    for (const job of awaiting) {
      if (!job.recoveryMessageId) continue;
      const relatedFailure = leadMessages.some(
        (message) => message.agentError?.failedMessageId === job.recoveryMessageId
      );
      if (relatedFailure) continue;
      const targetMessages = await deps.getInboxMessages(teamName, job.signal.memberName);
      const recoveryMessage = targetMessages.find(
        (message) => message.messageId === job.recoveryMessageId
      );
      if (!recoveryMessage) continue;
      if (job.signal.providerId === 'opencode' || job.signal.targetKind === 'lead') {
        const relay = await deps.relay(teamName, job.signal.memberName, {
          source: 'manual',
          onlyMessageId: job.recoveryMessageId,
        });
        const responseState = relay.lastDelivery?.responseState;
        const responseProven =
          job.signal.providerId === 'opencode'
            ? relay.lastDelivery?.delivered === true &&
              responseState?.startsWith('responded_') === true
            : relay.lastDelivery?.responsePending === false;
        if (responseProven) {
          await outcomes.markCompleted({ teamName, recoveryMessageId: job.recoveryMessageId });
        } else if (
          job.signal.providerId === 'opencode' &&
          relay.lastDelivery?.delivered === true &&
          relay.lastDelivery.responsePending === false &&
          responseState
        ) {
          await signals.observeRecoveryOutcomeFailure({
            job,
            recoveryMessageId: job.recoveryMessageId,
            responseState,
            detail: relay.lastDelivery.reason ?? responseState,
            observedAt: clock.now().toISOString(),
          });
        }
      } else if (recoveryMessage.read) {
        await outcomes.markCompleted({ teamName, recoveryMessageId: job.recoveryMessageId });
      }
    }
  };

  const scan = async (teamName: string): Promise<void> => {
    if (disposed) return;
    const existing = scansInFlight.get(teamName);
    if (existing) return existing;
    const request = (async () => {
      await signals.scanTeamInbox(teamName);
      const snapshot = await deps.getRuntimeSnapshot(teamName);
      for (const entry of Object.values(snapshot.members)) {
        if (!entry.alive || entry.providerId !== 'opencode') continue;
        const advisory = await deps.getMemberAdvisory(teamName, entry.memberName);
        if (advisory) {
          await signals.observeMemberAdvisory({ teamName, memberName: entry.memberName, advisory });
        }
      }
      await reconcileOutcomes(teamName);
      await cancelStale.execute(teamName);
      scheduler.wake();
    })()
      .catch((error) =>
        deps.logger?.warn('team runtime recovery scan failed', {
          teamName,
          error: String(error),
        })
      )
      .finally(() => {
        if (scansInFlight.get(teamName) === request) scansInFlight.delete(teamName);
      });
    scansInFlight.set(teamName, request);
    return request;
  };

  const scheduleScan = (teamName: string): void => {
    if (disposed) return;
    const existing = scanTimers.get(teamName);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      scanTimers.delete(teamName);
      void scan(teamName);
    }, SCAN_DEBOUNCE_MS);
    timer.unref?.();
    scanTimers.set(teamName, timer);
  };

  const handleConfigChanged = (): void => {
    void (async () => {
      const current = config.getConfig();
      const teams = await repository.listTeamNames();
      for (const teamName of teams) {
        await cancel.execute({
          teamName,
          reason: 'setting_disabled',
          matches: (job) =>
            job.reasonCode === 'rate_limited' || job.reasonCode === 'quota_exhausted'
              ? !current.rateLimitsEnabled
              : !current.transientErrorsEnabled,
        });
      }
      scheduler.wake();
    })().catch((error) =>
      deps.logger?.warn('team runtime recovery config reconciliation failed', {
        error: String(error),
      })
    );
  };
  const unsubscribeConfig = deps.configManager.onConfigChanged((section) => {
    if (section === 'teamRuntimeRecovery' || section === 'reload') handleConfigChanged();
  });

  return {
    start() {
      scheduler.start();
      void Promise.all([deps.listActiveTeamNames(), repository.listTeamNames()])
        .then(async ([activeTeamNames, persistedTeamNames]) => {
          const active = new Set(activeTeamNames);
          for (const teamName of persistedTeamNames) {
            if (!active.has(teamName)) {
              await cancel.execute({ teamName, reason: 'team_stopped' });
            }
          }
          for (const teamName of activeTeamNames) scheduleScan(teamName);
        })
        .catch((error) =>
          deps.logger?.warn('team runtime recovery startup reconciliation failed', {
            error: String(error),
          })
        );
    },
    noteTeamChange(event) {
      if (
        event.type === 'inbox' ||
        event.type === 'member-advisory' ||
        event.type === 'member-turn-settled' ||
        event.type === 'config' ||
        event.type === 'task' ||
        event.type === 'member-spawn'
      ) {
        scheduleScan(event.teamName);
      }
      if (event.type === 'process' || event.type === 'lead-activity') {
        void deps
          .isTeamActive(event.teamName)
          .then((active) => {
            if (active) scheduleScan(event.teamName);
            else return cancel.execute({ teamName: event.teamName, reason: 'team_stopped' });
          })
          .catch((error) =>
            deps.logger?.warn('team runtime recovery activity reconciliation failed', {
              teamName: event.teamName,
              error: String(error),
            })
          );
      }
    },
    observeLeadFailure(failure) {
      void signals
        .observeLeadFailure(failure)
        .then(() => scheduler.wake())
        .catch((error) =>
          deps.logger?.warn('team runtime recovery lead failure observation failed', {
            teamName: failure.teamName,
            error: String(error),
          })
        );
    },
    cancelTeam(teamName, reason) {
      return cancel.execute({ teamName, reason });
    },
    async cancelAll(reason) {
      const teamNames = await repository.listTeamNames();
      const counts = await Promise.all(
        teamNames.map((teamName) => cancel.execute({ teamName, reason }))
      );
      return counts.reduce((total, count) => total + count, 0);
    },
    async dispose() {
      disposed = true;
      unsubscribeConfig();
      for (const timer of scanTimers.values()) clearTimeout(timer);
      scanTimers.clear();
      await Promise.allSettled(scansInFlight.values());
      await scheduler.dispose();
    },
  };
}
