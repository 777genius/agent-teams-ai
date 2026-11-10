import type { RuntimeFailureSignal } from '../../../contracts';
import type {
  ObserveRuntimeFailure,
  ObserveRuntimeFailureResult,
  RuntimeRecoveryJob,
} from '../../../core/application';
import type {
  InboxMessage,
  MemberRuntimeAdvisory,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

function normalize(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? '';
}

function findRuntimeEntry(
  snapshot: TeamAgentRuntimeSnapshot,
  memberName: string
): TeamAgentRuntimeEntry | undefined {
  return Object.values(snapshot.members).find(
    (entry) => normalize(entry.memberName) === normalize(memberName)
  );
}

function isLegacyTerminalAgentError(message: InboxMessage): boolean {
  if (message.messageKind !== 'agent_error') return false;
  const text = message.text.toLowerCase();
  if (text.includes('scheduling one recovery turn')) return false;
  return (
    text.includes('mailbox turn execution error') ||
    text.includes('could not recover') ||
    /api\s*error\s*:/i.test(message.text)
  );
}

export class RuntimeRecoverySignalAdapter {
  constructor(
    private readonly deps: {
      observe: Pick<ObserveRuntimeFailure, 'execute'>;
      getCurrentContextId(): string;
      getRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
      getLeadName(teamName: string): Promise<string | null>;
      getInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
    }
  ) {}

  async scanTeamInbox(teamName: string): Promise<ObserveRuntimeFailureResult[]> {
    const [snapshot, leadName] = await Promise.all([
      this.deps.getRuntimeSnapshot(teamName),
      this.deps.getLeadName(teamName),
    ]);
    if (!leadName) return [];
    const messages = await this.deps.getInboxMessages(teamName, leadName);
    const results: ObserveRuntimeFailureResult[] = [];
    for (const message of messages) {
      if (!message.messageId || (!message.agentError && !isLegacyTerminalAgentError(message))) {
        continue;
      }
      const memberName = message.from.trim();
      if (!memberName || normalize(memberName) === 'system') continue;
      const entry = findRuntimeEntry(snapshot, memberName);
      const metadata = message.agentError;
      const failedMessageId = metadata?.failedMessageId;
      const failedMessage = failedMessageId
        ? (await this.deps.getInboxMessages(teamName, memberName)).find(
            (candidate) => candidate.messageId === failedMessageId
          )
        : undefined;
      results.push(
        await this.deps.observe.execute({
          id: `mailbox:${teamName}:${message.messageId}`,
          source: metadata ? 'agent_error_mailbox' : 'legacy_message_scan',
          phase: 'terminal',
          observedAt: message.timestamp,
          contextId: this.deps.getCurrentContextId(),
          teamName,
          memberName,
          targetKind: normalize(memberName) === normalize(leadName) ? 'lead' : 'member',
          detail: metadata?.detail ?? message.text,
          runId: metadata?.bootstrapRunId ?? snapshot.runId ?? undefined,
          runtimeSessionId: metadata?.runtimeSessionId ?? entry?.runtimeSessionId,
          providerId: entry?.providerId,
          providerBackendId: entry?.providerBackendId,
          model: entry?.runtimeModel,
          sourceMessageId: message.messageId,
          failedMessageId,
          causedByRecoveryMessageId:
            failedMessage?.messageKind === 'runtime_recovery_nudge'
              ? failedMessage.messageId
              : undefined,
          innerRecoveryAttempts: metadata?.innerRecoveryAttempts,
          taskRefs: failedMessage?.taskRefs,
        })
      );
    }
    return results;
  }

  async observeLeadFailure(input: {
    teamName: string;
    memberName: string;
    runId: string;
    runtimeSessionId?: string;
    phase: 'sdk_retrying' | 'terminal';
    detail: string;
    statusCode?: number;
    retryAfterMs?: number;
    observedAt: string;
    providerId?: RuntimeFailureSignal['providerId'];
    providerBackendId?: string;
    model?: string;
    causedByRecoveryMessageId?: string;
  }): Promise<ObserveRuntimeFailureResult> {
    return this.deps.observe.execute({
      id: `lead:${input.runId}:${input.phase}:${input.observedAt}:${input.statusCode ?? 'none'}`,
      source: 'lead_stream',
      phase: input.phase,
      observedAt: input.observedAt,
      contextId: this.deps.getCurrentContextId(),
      teamName: input.teamName,
      memberName: input.memberName,
      targetKind: 'lead',
      detail: input.detail,
      statusCode: input.statusCode,
      retryAfterMs: input.retryAfterMs,
      runId: input.runId,
      runtimeSessionId: input.runtimeSessionId,
      providerId: input.providerId,
      providerBackendId: input.providerBackendId,
      model: input.model,
      causedByRecoveryMessageId: input.causedByRecoveryMessageId,
    });
  }

  async observeMemberAdvisory(input: {
    teamName: string;
    memberName: string;
    advisory: MemberRuntimeAdvisory;
  }): Promise<ObserveRuntimeFailureResult> {
    const snapshot = await this.deps.getRuntimeSnapshot(input.teamName);
    const entry = findRuntimeEntry(snapshot, input.memberName);
    const signal: RuntimeFailureSignal = {
      id: `advisory:${input.teamName}:${input.memberName}:${input.advisory.observedAt}:${input.advisory.kind}`,
      source: 'member_runtime_advisory',
      phase: input.advisory.kind === 'sdk_retrying' ? 'sdk_retrying' : 'terminal',
      observedAt: input.advisory.observedAt,
      contextId: this.deps.getCurrentContextId(),
      teamName: input.teamName,
      memberName: input.memberName,
      targetKind: 'member',
      detail: input.advisory.message ?? input.advisory.reasonCode ?? input.advisory.kind,
      statusCode: input.advisory.statusCode,
      retryAfterMs: input.advisory.retryDelayMs,
      resetAt: input.advisory.retryUntil,
      runId: snapshot.runId ?? undefined,
      runtimeSessionId: entry?.runtimeSessionId,
      providerId: entry?.providerId,
      providerBackendId: entry?.providerBackendId,
      model: entry?.runtimeModel,
    };
    return this.deps.observe.execute(signal);
  }

  async observeRecoveryOutcomeFailure(input: {
    job: RuntimeRecoveryJob;
    recoveryMessageId: string;
    responseState: string;
    detail: string;
    observedAt: string;
  }): Promise<ObserveRuntimeFailureResult> {
    return this.deps.observe.execute({
      ...input.job.signal,
      id: `recovery-outcome:${input.job.id}:${input.recoveryMessageId}:${input.responseState}`,
      source: 'member_runtime_advisory',
      phase: 'terminal',
      observedAt: input.observedAt,
      detail: input.detail,
      causedByRecoveryMessageId: input.recoveryMessageId,
    });
  }
}
