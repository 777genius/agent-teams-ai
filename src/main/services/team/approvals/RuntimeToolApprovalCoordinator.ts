import { shouldAutoAllow } from '@main/utils/toolApprovalRules';

import type {
  TeamRuntimeApprovalProviderId,
  TeamRuntimeMemberSpec,
} from '../runtime/TeamRuntimeAdapter';
import type {
  ToolApprovalAutoResolved,
  ToolApprovalDismiss,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types/team';

export type RuntimeApprovalProviderId = TeamRuntimeApprovalProviderId;

export type RuntimeApprovalDecision = 'allow' | 'deny';

export interface RuntimeApprovalLaunchPolicy {
  providerId: RuntimeApprovalProviderId;
  mode: 'auto' | 'manual';
  config: Record<string, unknown>;
}

export interface RuntimeApprovalProviderPort<TContext = unknown, TRuntimeState = unknown> {
  readonly providerId: RuntimeApprovalProviderId;
  buildLaunchPolicy(skipPermissions: boolean, context: TContext): RuntimeApprovalLaunchPolicy;
  collectPendingApprovals(runtimeState: TRuntimeState): RuntimeToolApprovalEntry[];
  answerApproval(input: RuntimeToolApprovalAnswerInput): Promise<void>;
  assertManualSupported(context: TContext): void;
}

export interface RuntimeToolApprovalEntry {
  providerId: RuntimeApprovalProviderId;
  approval: ToolApprovalRequest;
  providerRequestId: string;
  laneId: string;
  memberName: string;
  cwd?: string;
  expectedMembers?: TeamRuntimeMemberSpec[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeToolApprovalAnswerInput {
  entry: RuntimeToolApprovalEntry;
  allow: boolean;
  message?: string;
}

export type RuntimeToolApprovalEvent =
  | ToolApprovalRequest
  | ToolApprovalDismiss
  | ToolApprovalAutoResolved;

export interface RuntimeToolApprovalCoordinatorDeps {
  getSettings(teamName: string): ToolApprovalSettings;
  answerApproval(input: RuntimeToolApprovalAnswerInput): Promise<void>;
  emitApprovalEvent(event: RuntimeToolApprovalEvent): void;
  showApprovalNotification?(approval: ToolApprovalRequest): void;
  dismissApprovalNotification?(requestId: string): void;
  logWarning?(message: string): void;
}

export interface RuntimeToolApprovalSyncScope {
  teamName: string;
  runId: string;
  laneId?: string;
  providerId?: RuntimeApprovalProviderId;
}

export interface RuntimeToolApprovalClearOptions {
  runId?: string;
  laneId?: string;
  providerId?: RuntimeApprovalProviderId;
  emitDismiss?: boolean;
}

export function mapAppApprovalDecisionToProviderDecision(
  decision: RuntimeApprovalDecision
): 'allow' | 'reject' {
  return decision === 'allow' ? 'allow' : 'reject';
}

export class RuntimeToolApprovalCoordinator {
  private readonly approvalsByTeam = new Map<string, Map<string, RuntimeToolApprovalEntry>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightResponses = new Set<string>();

  constructor(private readonly deps: RuntimeToolApprovalCoordinatorDeps) {}

  sync(scope: RuntimeToolApprovalSyncScope, entries: RuntimeToolApprovalEntry[]): void {
    const observedRequestIds = new Set<string>();
    for (const entry of entries) {
      observedRequestIds.add(entry.approval.requestId);
      this.register(entry);
    }

    const approvals = this.approvalsByTeam.get(scope.teamName);
    if (!approvals) {
      return;
    }

    for (const [requestId, entry] of approvals) {
      if (!this.matchesScope(entry, scope)) {
        continue;
      }
      if (observedRequestIds.has(requestId)) {
        continue;
      }
      this.removeEntry(entry);
      this.deps.emitApprovalEvent({
        autoResolved: true,
        requestId,
        runId: entry.approval.runId,
        teamName: entry.approval.teamName,
        reason: 'runtime_resolved',
      } as ToolApprovalAutoResolved);
    }
  }

  register(entry: RuntimeToolApprovalEntry): void {
    const requestId = entry.approval.requestId;
    if (!requestId) {
      return;
    }
    const approvals = this.getTeamApprovals(entry.approval.teamName);
    if (approvals.has(requestId) || this.inFlightResponses.has(requestId)) {
      return;
    }

    const autoResult = shouldAutoAllow(
      this.deps.getSettings(entry.approval.teamName),
      entry.approval.toolName,
      entry.approval.toolInput
    );
    if (autoResult.autoAllow) {
      void this.answerUntracked(entry, true, undefined, 'auto_allow_category');
      return;
    }

    approvals.set(requestId, entry);
    this.deps.emitApprovalEvent(entry.approval);
    this.startTimeout(entry);
    this.deps.showApprovalNotification?.(entry.approval);
  }

  async respond(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<boolean> {
    const entry = this.approvalsByTeam.get(teamName)?.get(requestId);
    if (!entry) {
      return false;
    }
    if (entry.approval.runId !== runId) {
      throw new Error(
        `Stale approval: runId mismatch (expected ${entry.approval.runId}, got ${runId})`
      );
    }

    this.clearTimer(requestId);
    if (!this.tryClaimResponse(requestId)) {
      return true;
    }

    try {
      await this.deps.answerApproval({ entry, allow, message });
    } catch (error) {
      this.inFlightResponses.delete(requestId);
      if (this.get(entry.approval.teamName, requestId) === entry) {
        this.startTimeout(entry);
      }
      throw error;
    }
    this.removeEntry(entry);
    this.inFlightResponses.delete(requestId);
    return true;
  }

  clear(teamName: string, options: RuntimeToolApprovalClearOptions = {}): number {
    const approvals = this.approvalsByTeam.get(teamName);
    if (!approvals) {
      return 0;
    }

    let removed = 0;
    const removedRunIds = new Set<string>();
    for (const entry of Array.from(approvals.values())) {
      if (!this.matchesClearOptions(entry, options)) {
        continue;
      }
      this.removeEntry(entry);
      removed += 1;
      removedRunIds.add(entry.approval.runId);
    }

    if (removed > 0 && options.emitDismiss) {
      for (const runId of removedRunIds) {
        this.deps.emitApprovalEvent({ dismissed: true, teamName, runId });
      }
    }

    return removed;
  }

  reEvaluate(): void {
    for (const approvals of Array.from(this.approvalsByTeam.values())) {
      for (const entry of Array.from(approvals.values())) {
        const requestId = entry.approval.requestId;
        const settings = this.deps.getSettings(entry.approval.teamName);
        const autoResult = shouldAutoAllow(
          settings,
          entry.approval.toolName,
          entry.approval.toolInput
        );
        if (autoResult.autoAllow) {
          this.clearTimer(requestId);
          void this.answerTracked(entry, true, undefined, 'auto_allow_category');
          continue;
        }

        if (settings.timeoutAction === 'wait') {
          this.clearTimer(requestId);
        } else if (!this.timers.has(requestId)) {
          this.startTimeout(entry);
        }
      }
    }
  }

  get(teamName: string, requestId: string): RuntimeToolApprovalEntry | undefined {
    return this.approvalsByTeam.get(teamName)?.get(requestId);
  }

  size(teamName?: string): number {
    if (teamName) {
      return this.approvalsByTeam.get(teamName)?.size ?? 0;
    }
    let total = 0;
    for (const approvals of this.approvalsByTeam.values()) {
      total += approvals.size;
    }
    return total;
  }

  dispose(): void {
    for (const requestId of Array.from(this.timers.keys())) {
      this.clearTimer(requestId);
    }
    this.approvalsByTeam.clear();
    this.inFlightResponses.clear();
  }

  private startTimeout(entry: RuntimeToolApprovalEntry): void {
    const { timeoutAction, timeoutSeconds } = this.deps.getSettings(entry.approval.teamName);
    if (timeoutAction === 'wait') {
      return;
    }

    const requestId = entry.approval.requestId;
    if (this.timers.has(requestId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(requestId);
      const current = this.get(entry.approval.teamName, requestId);
      if (!current) {
        return;
      }
      const currentAction = this.deps.getSettings(entry.approval.teamName).timeoutAction;
      if (currentAction === 'wait') {
        return;
      }
      const allow = currentAction === 'allow';
      void this.answerTracked(
        current,
        allow,
        allow ? undefined : 'Timed out - auto-denied by settings',
        allow ? 'timeout_allow' : 'timeout_deny'
      );
    }, timeoutSeconds * 1000);
    timer.unref?.();
    this.timers.set(requestId, timer);
  }

  private async answerTracked(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    message: string | undefined,
    reason: ToolApprovalAutoResolved['reason']
  ): Promise<void> {
    const requestId = entry.approval.requestId;
    if (!this.tryClaimResponse(requestId)) {
      return;
    }
    try {
      await this.deps.answerApproval({ entry, allow, message });
      this.removeEntry(entry);
      this.deps.emitApprovalEvent({
        autoResolved: true,
        requestId,
        runId: entry.approval.runId,
        teamName: entry.approval.teamName,
        reason,
      } as ToolApprovalAutoResolved);
    } catch (error) {
      this.deps.logWarning?.(
        `[${entry.approval.teamName}] Failed to auto-resolve runtime approval ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (this.get(entry.approval.teamName, requestId) === entry) {
        this.startTimeout(entry);
      }
    } finally {
      this.inFlightResponses.delete(requestId);
    }
  }

  private async answerUntracked(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    message: string | undefined,
    reason: ToolApprovalAutoResolved['reason']
  ): Promise<void> {
    const requestId = entry.approval.requestId;
    if (!this.tryClaimResponse(requestId)) {
      return;
    }
    try {
      await this.deps.answerApproval({ entry, allow, message });
      this.deps.emitApprovalEvent({
        autoResolved: true,
        requestId,
        runId: entry.approval.runId,
        teamName: entry.approval.teamName,
        reason,
      } as ToolApprovalAutoResolved);
    } catch (error) {
      this.deps.logWarning?.(
        `[${entry.approval.teamName}] Failed to auto-resolve runtime approval ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.inFlightResponses.delete(requestId);
    }
  }

  private removeEntry(entry: RuntimeToolApprovalEntry): void {
    const requestId = entry.approval.requestId;
    this.clearTimer(requestId);
    this.inFlightResponses.delete(requestId);
    this.deps.dismissApprovalNotification?.(requestId);
    const approvals = this.approvalsByTeam.get(entry.approval.teamName);
    if (!approvals) {
      return;
    }
    approvals.delete(requestId);
    if (approvals.size === 0) {
      this.approvalsByTeam.delete(entry.approval.teamName);
    }
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(requestId);
  }

  private tryClaimResponse(requestId: string): boolean {
    if (this.inFlightResponses.has(requestId)) {
      return false;
    }
    this.inFlightResponses.add(requestId);
    return true;
  }

  private getTeamApprovals(teamName: string): Map<string, RuntimeToolApprovalEntry> {
    const existing = this.approvalsByTeam.get(teamName);
    if (existing) {
      return existing;
    }
    const approvals = new Map<string, RuntimeToolApprovalEntry>();
    this.approvalsByTeam.set(teamName, approvals);
    return approvals;
  }

  private matchesScope(
    entry: RuntimeToolApprovalEntry,
    scope: RuntimeToolApprovalSyncScope
  ): boolean {
    if (entry.approval.teamName !== scope.teamName) {
      return false;
    }
    if (entry.approval.runId !== scope.runId) {
      return false;
    }
    if (scope.laneId && entry.laneId !== scope.laneId) {
      return false;
    }
    if (scope.providerId && entry.providerId !== scope.providerId) {
      return false;
    }
    return true;
  }

  private matchesClearOptions(
    entry: RuntimeToolApprovalEntry,
    options: RuntimeToolApprovalClearOptions
  ): boolean {
    if (options.runId && entry.approval.runId !== options.runId) {
      return false;
    }
    if (options.laneId && entry.laneId !== options.laneId) {
      return false;
    }
    if (options.providerId && entry.providerId !== options.providerId) {
      return false;
    }
    return true;
  }
}
