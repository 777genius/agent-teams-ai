import {
  decideOpenCodeRuntimeDeliveryAdvisory,
  getOpenCodeRuntimeDeliveryAdvisoryReasonKey,
  isPotentialOpenCodeRuntimeDeliveryError,
  type OpenCodeRuntimeDeliveryAdvisoryDecision,
} from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type {
  OpenCodeRuntimeDeliveryProofIndex,
  OpenCodeRuntimeDeliveryProofReaderInput,
} from '../opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import type { InboxMessage, TaskRef, TeamChangeEvent } from '@shared/types';

export const OPENCODE_RUNTIME_DELIVERY_ADVISORY_EVENT_TTL_MS = 24 * 60 * 60_000;
export const OPENCODE_RUNTIME_DELIVERY_LEAD_NOTICE_TTL_MS = 24 * 60 * 60_000;

export type MemberWorkSyncProofMissingRecoveryScheduler = (input: {
  teamName: string;
  memberName: string;
  originalMessageId: string;
  taskRefs?: TaskRef[];
  reason?: string;
}) => Promise<unknown> | unknown;

export interface OpenCodeRuntimeDeliveryErrorNotification {
  teamEventType: 'api_error';
  teamName: string;
  teamDisplayName: string;
  from: string;
  summary: string;
  body: string;
  dedupeKey: string;
  target: {
    kind: 'member';
    teamName: string;
    memberName: string;
    focus: 'messages';
  };
  projectPath?: string;
}

export interface OpenCodeRuntimeDeliveryAdvisoryTeamConfig {
  name?: string | null;
  projectPath?: string;
}

export interface OpenCodeRuntimeDeliveryLeadNoticeSink {
  send(message: string): Promise<void>;
}

export interface OpenCodeRuntimeDeliveryAdvisoryPorts {
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): Pick<OpenCodePromptDeliveryLedgerStore, 'list'>;
  readProofIndex(
    input: OpenCodeRuntimeDeliveryProofReaderInput
  ): Promise<OpenCodeRuntimeDeliveryProofIndex | null>;
  readConfigSnapshot(teamName: string): Promise<OpenCodeRuntimeDeliveryAdvisoryTeamConfig | null>;
  addTeamNotification(notification: OpenCodeRuntimeDeliveryErrorNotification): Promise<void>;
  emitTeamChange(event: TeamChangeEvent): void;
  invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void;
  scheduleProofMissingWorkSyncRecovery: MemberWorkSyncProofMissingRecoveryScheduler | null;
  getLeadNoticeSink(teamName: string): OpenCodeRuntimeDeliveryLeadNoticeSink | null;
  logInfo(message: string, detail?: string): void;
  logWarning(message: string): void;
  getErrorMessage(error: unknown): string;
  nowMs?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  advisoryEventDedupeTtlMs?: number;
  leadNoticeDedupeTtlMs?: number;
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryLeadRun {
  processKilled?: boolean;
  cancelRequested?: boolean;
  child?: {
    stdin?: {
      writable?: boolean;
    } | null;
  } | null;
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<
  TRun extends TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryLeadRun,
> {
  runs: ReadonlyMap<string, TRun>;
  runTracking: {
    getAliveRunId(teamName: string): string | null | undefined;
  };
  configFacade: {
    readConfigSnapshot: OpenCodeRuntimeDeliveryAdvisoryPorts['readConfigSnapshot'];
  };
  openCodeRuntimeDeliveryProofReader: {
    readProofIndex: OpenCodeRuntimeDeliveryAdvisoryPorts['readProofIndex'];
  };
  appShellBoundary: {
    getMemberRuntimeAdvisoryInvalidator():
      | ((teamName: string, memberName: string) => unknown)
      | null
      | undefined;
    getMemberWorkSyncProofMissingRecoveryScheduler():
      | MemberWorkSyncProofMissingRecoveryScheduler
      | null
      | undefined;
  };
  teamChangeEmitter?: OpenCodeRuntimeDeliveryAdvisoryPorts['emitTeamChange'] | null;
  createOpenCodePromptDeliveryLedger: OpenCodeRuntimeDeliveryAdvisoryPorts['createOpenCodePromptDeliveryLedger'];
  sendMessageToRun(run: TRun, message: string): Promise<void>;
}

export interface TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHostOptions {
  addTeamNotification: OpenCodeRuntimeDeliveryAdvisoryPorts['addTeamNotification'];
  logInfo: OpenCodeRuntimeDeliveryAdvisoryPorts['logInfo'];
  logWarning: OpenCodeRuntimeDeliveryAdvisoryPorts['logWarning'];
  getErrorMessage: OpenCodeRuntimeDeliveryAdvisoryPorts['getErrorMessage'];
  nowMs?: OpenCodeRuntimeDeliveryAdvisoryPorts['nowMs'];
  setTimeout?: OpenCodeRuntimeDeliveryAdvisoryPorts['setTimeout'];
  clearTimeout?: OpenCodeRuntimeDeliveryAdvisoryPorts['clearTimeout'];
  advisoryEventDedupeTtlMs?: OpenCodeRuntimeDeliveryAdvisoryPorts['advisoryEventDedupeTtlMs'];
  leadNoticeDedupeTtlMs?: OpenCodeRuntimeDeliveryAdvisoryPorts['leadNoticeDedupeTtlMs'];
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryPortsFromService<
  TRun extends TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryLeadRun,
>(
  service: TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<TRun>,
  options: TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHostOptions
): OpenCodeRuntimeDeliveryAdvisoryPorts {
  return {
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      service.createOpenCodePromptDeliveryLedger(teamName, laneId),
    readProofIndex: (input) => service.openCodeRuntimeDeliveryProofReader.readProofIndex(input),
    readConfigSnapshot: (teamName) => service.configFacade.readConfigSnapshot(teamName),
    addTeamNotification: (notification) => options.addTeamNotification(notification),
    emitTeamChange: (event) => {
      service.teamChangeEmitter?.(event);
    },
    invalidateMemberRuntimeAdvisory: (teamName, memberName) => {
      service.appShellBoundary.getMemberRuntimeAdvisoryInvalidator()?.(teamName, memberName);
    },
    scheduleProofMissingWorkSyncRecovery: async (input) => {
      const scheduler = service.appShellBoundary.getMemberWorkSyncProofMissingRecoveryScheduler();
      if (scheduler) {
        await scheduler(input);
      }
    },
    getLeadNoticeSink: (teamName) => {
      const runId = service.runTracking.getAliveRunId(teamName);
      const run = runId ? service.runs.get(runId) : null;
      if (!run || run.processKilled || run.cancelRequested) {
        return null;
      }
      if (run.child && !run.child.stdin?.writable) {
        return null;
      }
      return {
        send: (message) => service.sendMessageToRun(run, message),
      };
    },
    logInfo: options.logInfo,
    logWarning: options.logWarning,
    getErrorMessage: options.getErrorMessage,
    nowMs: options.nowMs,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    advisoryEventDedupeTtlMs: options.advisoryEventDedupeTtlMs,
    leadNoticeDedupeTtlMs: options.leadNoticeDedupeTtlMs,
  };
}

export function createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService<
  TRun extends TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryLeadRun,
>(
  service: TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<TRun>,
  options: TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHostOptions
): TeamProvisioningOpenCodeRuntimeDeliveryAdvisory {
  return new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory(
    createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryPortsFromService(service, options)
  );
}

export class TeamProvisioningOpenCodeRuntimeDeliveryAdvisory {
  private readonly advisoryReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly advisoryEventSentAt = new Map<string, number>();
  private readonly leadNoticeSentAt = new Map<string, number>();

  constructor(private readonly ports: OpenCodeRuntimeDeliveryAdvisoryPorts) {}

  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra: Record<string, unknown> = {}
  ): void {
    this.ports.logInfo(
      event,
      JSON.stringify({
        teamName: record.teamName,
        memberName: record.memberName,
        laneId: record.laneId,
        runId: record.runId,
        inboxMessageId: record.inboxMessageId,
        runtimeSessionId: record.runtimeSessionId,
        status: record.status,
        responseState: record.responseState,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        visibleReplyCorrelation: record.visibleReplyCorrelation,
        reason: record.lastReason,
        ...extra,
      })
    );
    const shouldNotifyTerminalFailure =
      event === 'opencode_prompt_delivery_terminal_failure' && record.status === 'failed_terminal';
    const shouldNotifyActionRequiredRetry =
      !shouldNotifyTerminalFailure && isPotentialOpenCodeRuntimeDeliveryError(record);
    if (shouldNotifyTerminalFailure || shouldNotifyActionRequiredRetry) {
      void this.handleUserFacingSideEffects(record).catch((error) => {
        this.ports.logWarning(
          `[${record.teamName}] Failed to handle OpenCode runtime delivery advisory side effects for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
        );
      });
    }
  }

  emitPromptDeliveryTaskLogChange(
    record: OpenCodePromptDeliveryLedgerRecord,
    detail: string
  ): void {
    if (!record.runtimeSessionId?.trim() || record.taskRefs.length === 0) {
      return;
    }
    const taskIds = new Set(
      record.taskRefs
        .map((taskRef) => taskRef.taskId?.trim() || taskRef.displayId?.trim())
        .filter((taskId): taskId is string => Boolean(taskId))
    );
    for (const taskId of taskIds) {
      this.ports.emitTeamChange({
        type: 'task-log-change',
        teamName: record.teamName,
        ...(record.runId ? { runId: record.runId } : {}),
        taskId,
        detail,
        taskSignalKind: 'log',
      });
    }
  }

  async handleUserFacingSideEffects(record: OpenCodePromptDeliveryLedgerRecord): Promise<void> {
    const { record: latestRecord, decision } = await this.decideUserFacingAdvisory(record);
    if (decision.action === 'defer') {
      this.emitAdvisoryEvent(latestRecord, decision);
      this.scheduleAdvisoryReview(latestRecord, decision);
      return;
    }
    if (decision.action === 'suppress') {
      this.emitAdvisoryEvent(latestRecord, decision);
      return;
    }

    this.emitAdvisoryEvent(latestRecord, decision);
    await this.scheduleProofMissingWorkSyncRecovery(latestRecord, decision);
    if (decision.severity !== 'error') {
      return;
    }

    await this.fireErrorNotification(latestRecord, decision);
  }

  async decideUserFacingAdvisory(record: OpenCodePromptDeliveryLedgerRecord): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision;
  }> {
    const memberKey = record.memberName.trim().toLowerCase();
    let recordsForMember: OpenCodePromptDeliveryLedgerRecord[] = [record];
    let ledgerReadSucceeded = false;
    try {
      const laneRecords = await this.ports
        .createOpenCodePromptDeliveryLedger(record.teamName, record.laneId)
        .list();
      ledgerReadSucceeded = true;
      recordsForMember = laneRecords.filter(
        (candidate) => candidate.memberName.trim().toLowerCase() === memberKey
      );
    } catch {
      recordsForMember = [record];
    }
    const latestRecord = recordsForMember.find((candidate) => candidate.id === record.id) ?? null;
    if (!latestRecord && ledgerReadSucceeded) {
      return {
        record,
        decision: { action: 'suppress' },
      };
    }
    const recordForDecision = latestRecord ?? record;
    const recordsByMember = new Map<string, readonly OpenCodePromptDeliveryLedgerRecord[]>([
      [memberKey, recordsForMember.length > 0 ? recordsForMember : [recordForDecision]],
    ]);
    const activeMemberKeys = new Set([memberKey]);
    const proofIndex = await this.ports
      .readProofIndex({
        teamName: recordForDecision.teamName,
        activeMemberKeys,
        recordsByMember,
      })
      .catch(() => null);
    return {
      record: recordForDecision,
      decision: decideOpenCodeRuntimeDeliveryAdvisory({
        record: recordForDecision,
        proof: proofIndex?.getSnapshot(recordForDecision.memberName, recordForDecision),
      }),
    };
  }

  async fireErrorNotification(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    const reason = decision.reason;
    if (!reason) {
      return;
    }

    const config = await this.ports.readConfigSnapshot(record.teamName).catch(() => null);
    const teamDisplayName = config?.name?.trim() || record.teamName;
    const taskLabel = record.taskRefs[0]?.displayId?.trim()
      ? `#${record.taskRefs[0].displayId.trim()}`
      : null;
    const context = taskLabel ? ` while handling ${taskLabel}` : '';
    const body = `Team ${teamDisplayName}: @${record.memberName} hit an OpenCode runtime delivery error${context}. ${reason}`;

    try {
      await this.ports.addTeamNotification({
        teamEventType: 'api_error',
        teamName: record.teamName,
        teamDisplayName,
        from: record.memberName,
        summary: taskLabel
          ? `OpenCode runtime error ${taskLabel}`
          : 'OpenCode runtime delivery error',
        body,
        dedupeKey: `opencode_runtime_delivery_error:${record.teamName}:${record.memberName}:${record.id}`,
        target: {
          kind: 'member',
          teamName: record.teamName,
          memberName: record.memberName,
          focus: 'messages',
        },
        projectPath: config?.projectPath,
      });
    } catch (error) {
      this.ports.logWarning(
        `[${record.teamName}] Failed to store OpenCode runtime delivery error notification for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }

    await this.notifyLeadAboutError({
      record,
      reason,
      taskLabel,
    });
  }

  async scheduleProofMissingWorkSyncRecovery(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    if (decision.reasonCode !== 'protocol_proof_missing') {
      return;
    }
    const scheduler = this.ports.scheduleProofMissingWorkSyncRecovery;
    if (!scheduler) {
      return;
    }

    try {
      await scheduler({
        teamName: record.teamName,
        memberName: record.memberName,
        originalMessageId: record.inboxMessageId,
        taskRefs: record.taskRefs,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    } catch (error) {
      this.ports.logWarning(
        `[${record.teamName}] Failed to schedule OpenCode proof-missing work sync recovery for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }
  }

  emitAdvisoryEvent(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision?: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    try {
      this.ports.invalidateMemberRuntimeAdvisory(record.teamName, record.memberName);
    } catch (error) {
      this.ports.logWarning(
        `[${record.teamName}] Failed to invalidate OpenCode runtime advisory cache for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }

    const reasonKey = getOpenCodeRuntimeDeliveryAdvisoryReasonKey({ record, decision });
    const eventKey = `opencode_runtime_delivery_error:${record.teamName}:${record.memberName}:${record.id}:${reasonKey}`;
    const now = this.getNowMs();
    this.pruneAdvisoryEventDedupe(now);
    if (this.advisoryEventSentAt.has(eventKey)) {
      return;
    }

    try {
      this.ports.emitTeamChange({
        type: 'member-advisory',
        teamName: record.teamName,
        detail: `opencode-runtime-delivery-error:${record.memberName}:${record.id}`,
      });
      this.advisoryEventSentAt.set(eventKey, now);
    } catch (error) {
      this.ports.logWarning(
        `[${record.teamName}] Failed to emit member advisory refresh for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }
  }

  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void {
    if (
      message.source !== 'runtime_delivery' ||
      typeof message.relayOfMessageId !== 'string' ||
      message.relayOfMessageId.trim().length === 0
    ) {
      return;
    }

    const memberName = message.from?.trim();
    if (!memberName || memberName === 'user' || memberName === 'system') {
      return;
    }

    try {
      this.ports.invalidateMemberRuntimeAdvisory(teamName, memberName);
    } catch (error) {
      this.ports.logWarning(
        `[${teamName}] Failed to invalidate runtime advisory after runtime delivery reply for ${memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }

    try {
      this.ports.emitTeamChange({
        type: 'member-advisory',
        teamName,
        detail: `runtime-delivery-reply:${memberName}:${message.relayOfMessageId.trim()}`,
      });
    } catch (error) {
      this.ports.logWarning(
        `[${teamName}] Failed to emit runtime advisory refresh after runtime delivery reply for ${memberName}: ${this.ports.getErrorMessage(error)}`
      );
    }
  }

  scheduleAdvisoryReview(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    const reviewAt = Date.parse(decision.nextReviewAt ?? '');
    if (!Number.isFinite(reviewAt)) {
      return;
    }
    const delayMs = Math.max(250, reviewAt - this.getNowMs());
    const timerKey = `${record.teamName}:${record.laneId}:${record.id}`;
    const existing = this.advisoryReviewTimers.get(timerKey);
    if (existing) {
      this.clearTimer(existing);
    }
    const timer = this.setTimer(() => {
      this.advisoryReviewTimers.delete(timerKey);
      void this.handleUserFacingSideEffects(record).catch((error) => {
        this.ports.logWarning(
          `[${record.teamName}] Failed to refresh deferred OpenCode runtime delivery advisory for ${record.memberName}: ${this.ports.getErrorMessage(error)}`
        );
      });
    }, delayMs);
    this.advisoryReviewTimers.set(timerKey, timer);
  }

  cancelTeam(teamName: string): void {
    const prefix = `${teamName}:`;
    for (const [timerKey, timer] of this.advisoryReviewTimers) {
      if (!timerKey.startsWith(prefix)) {
        continue;
      }
      this.clearTimer(timer);
      this.advisoryReviewTimers.delete(timerKey);
    }
  }

  async notifyLeadAboutError(input: {
    record: OpenCodePromptDeliveryLedgerRecord;
    reason: string;
    taskLabel: string | null;
  }): Promise<void> {
    const sink = this.ports.getLeadNoticeSink(input.record.teamName);
    if (!sink) {
      return;
    }

    const noticeKey = `opencode_runtime_delivery_error:${input.record.teamName}:${input.record.memberName}:${input.record.id}`;
    const now = this.getNowMs();
    this.pruneLeadNoticeDedupe(now);
    if (this.leadNoticeSentAt.has(noticeKey)) {
      return;
    }

    this.leadNoticeSentAt.set(noticeKey, now);
    const taskContext = input.taskLabel ? ` while handling ${input.taskLabel}` : '';
    const message = [
      `System notice: OpenCode teammate @${input.record.memberName} hit a runtime delivery error${taskContext}.`,
      `Reason: ${input.reason}`,
      `Treat @${input.record.memberName} as unavailable for that work until retry or restart succeeds.`,
      `Do not message the human user solely because of this notice unless user action is required.`,
    ].join(' ');

    try {
      await sink.send(message);
    } catch (error) {
      this.leadNoticeSentAt.delete(noticeKey);
      const errorMessage = this.ports.getErrorMessage(error);
      if (errorMessage.includes('process stdin is not writable')) {
        return;
      }
      this.ports.logWarning(
        `[${input.record.teamName}] Failed to notify lead about OpenCode runtime delivery error for ${input.record.memberName}: ${errorMessage}`
      );
    }
  }

  private pruneAdvisoryEventDedupe(now: number): void {
    const ttlMs =
      this.ports.advisoryEventDedupeTtlMs ?? OPENCODE_RUNTIME_DELIVERY_ADVISORY_EVENT_TTL_MS;
    for (const [key, sentAt] of this.advisoryEventSentAt) {
      if (now - sentAt > ttlMs) {
        this.advisoryEventSentAt.delete(key);
      }
    }
  }

  private pruneLeadNoticeDedupe(now: number): void {
    const ttlMs = this.ports.leadNoticeDedupeTtlMs ?? OPENCODE_RUNTIME_DELIVERY_LEAD_NOTICE_TTL_MS;
    for (const [key, sentAt] of this.leadNoticeSentAt) {
      if (now - sentAt > ttlMs) {
        this.leadNoticeSentAt.delete(key);
      }
    }
  }

  private getNowMs(): number {
    return this.ports.nowMs?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.ports.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.ports.clearTimeout) {
      this.ports.clearTimeout(timer);
      return;
    }
    clearTimeout(timer);
  }
}
