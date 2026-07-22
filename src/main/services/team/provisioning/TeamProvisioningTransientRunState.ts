import { AsyncLocalStorage } from 'node:async_hooks';

import {
  boundPendingLogLineCarry,
  boundRunClaudeLogLines,
  boundSingleRetainedLogLine,
} from './TeamProvisioningProgressBuffers';

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface DeleteByTeamName {
  delete(teamName: string): unknown;
}

interface PrefixScopedDeleteMap {
  keys(): IterableIterator<string>;
  delete(key: string): unknown;
}

export interface TeamProvisioningCliLogRun {
  claudeLogsUpdatedAt?: string;
  lastClaudeLogStream?: 'stdout' | 'stderr' | null;
  claudeLogLines: string[];
  stdoutLogLineBuf: string;
  stderrLogLineBuf: string;
}

export interface TeamProvisioningTransientRunStatePorts {
  pendingTimeouts: Map<string, TimeoutHandle>;
  teamOpLocks: Map<string, Promise<void>>;
  cancelPendingAutoResume(teamName: string): void;
  clearOpenCodeRuntimeToolApprovals(teamName: string, options: { emitDismiss: boolean }): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  clearRuntimeProcessRowsForTeam(teamName: string): void;
  retainedClaudeLogsByTeam: DeleteByTeamName;
  persistedTranscriptClaudeLogs: { invalidate(teamName: string): void };
  leadInboxRelayInFlight: DeleteByTeamName;
  relayedLeadInboxMessageIds: DeleteByTeamName;
  leadRecoveryMessageIds: DeleteByTeamName;
  successfulLeadRecoveryMessageIds: DeleteByTeamName;
  pendingCrossTeamFirstReplies: DeleteByTeamName;
  recentCrossTeamLeadDeliveryMessageIds: DeleteByTeamName;
  recentSameTeamNativeFingerprints: DeleteByTeamName;
  memberInboxRelayInFlight: PrefixScopedDeleteMap;
  openCodeMemberInboxRelayInFlight: PrefixScopedDeleteMap;
  openCodeMemberSendInFlightByLane: PrefixScopedDeleteMap;
  openCodePromptDeliveryWatchdogScheduler: { cancelTeam(teamName: string): void };
  openCodeRuntimeDeliveryAdvisory: { cancelTeam(teamName: string): void };
  relayedMemberInboxMessageIds: PrefixScopedDeleteMap;
  liveLeadProcessMessages: DeleteByTeamName;
  relayLeadInboxMessages(teamName: string): Promise<unknown>;
  warn(message: string): void;
  setTimeout(handler: () => void, ms: number): TimeoutHandle;
  clearTimeout(timer: TimeoutHandle): void;
  nowMs(): number;
}

export function createTeamProvisioningTransientRunStatePorts(
  ports: Omit<TeamProvisioningTransientRunStatePorts, 'setTimeout' | 'clearTimeout' | 'nowMs'> &
    Partial<Pick<TeamProvisioningTransientRunStatePorts, 'setTimeout' | 'clearTimeout' | 'nowMs'>>
): TeamProvisioningTransientRunStatePorts {
  return {
    ...ports,
    setTimeout: ports.setTimeout ?? ((handler, ms) => setTimeout(handler, ms)),
    clearTimeout: ports.clearTimeout ?? ((timer) => clearTimeout(timer)),
    nowMs: ports.nowMs ?? (() => Date.now()),
  };
}

export interface TeamProvisioningTransientRunStateServiceHost {
  pendingTimeouts: TeamProvisioningTransientRunStatePorts['pendingTimeouts'];
  teamOpLocks: TeamProvisioningTransientRunStatePorts['teamOpLocks'];
  toolApprovalFacade: {
    clearOpenCodeRuntimeToolApprovals: TeamProvisioningTransientRunStatePorts['clearOpenCodeRuntimeToolApprovals'];
  };
  invalidateRuntimeSnapshotCaches: TeamProvisioningTransientRunStatePorts['invalidateRuntimeSnapshotCaches'];
  runtimeResourceSampling: {
    clearRuntimeProcessRowsForTeam: TeamProvisioningTransientRunStatePorts['clearRuntimeProcessRowsForTeam'];
  };
  retainedClaudeLogsByTeam: TeamProvisioningTransientRunStatePorts['retainedClaudeLogsByTeam'];
  bootstrapTranscriptFacade: {
    invalidatePersistedTranscriptClaudeLogs: TeamProvisioningTransientRunStatePorts['persistedTranscriptClaudeLogs']['invalidate'];
  };
  leadInboxRelayInFlight: TeamProvisioningTransientRunStatePorts['leadInboxRelayInFlight'];
  relayedLeadInboxMessageIds: TeamProvisioningTransientRunStatePorts['relayedLeadInboxMessageIds'];
  leadRecoveryMessageIds: TeamProvisioningTransientRunStatePorts['leadRecoveryMessageIds'];
  successfulLeadRecoveryMessageIds: TeamProvisioningTransientRunStatePorts['successfulLeadRecoveryMessageIds'];
  pendingCrossTeamFirstReplies: TeamProvisioningTransientRunStatePorts['pendingCrossTeamFirstReplies'];
  recentCrossTeamLeadDeliveryMessageIds: TeamProvisioningTransientRunStatePorts['recentCrossTeamLeadDeliveryMessageIds'];
  sameTeamNativeDelivery: TeamProvisioningTransientRunStatePorts['recentSameTeamNativeFingerprints'];
  memberInboxRelayInFlight: TeamProvisioningTransientRunStatePorts['memberInboxRelayInFlight'];
  openCodeMemberInboxRelayInFlight: TeamProvisioningTransientRunStatePorts['openCodeMemberInboxRelayInFlight'];
  openCodeMemberSendInFlightByLane: TeamProvisioningTransientRunStatePorts['openCodeMemberSendInFlightByLane'];
  openCodePromptDeliveryWatchdogScheduler: TeamProvisioningTransientRunStatePorts['openCodePromptDeliveryWatchdogScheduler'];
  openCodeRuntimeDeliveryAdvisory: TeamProvisioningTransientRunStatePorts['openCodeRuntimeDeliveryAdvisory'];
  relayedMemberInboxMessageIds: TeamProvisioningTransientRunStatePorts['relayedMemberInboxMessageIds'];
  liveLeadProcessMessages: TeamProvisioningTransientRunStatePorts['liveLeadProcessMessages'];
  relayLeadInboxMessages: TeamProvisioningTransientRunStatePorts['relayLeadInboxMessages'];
}

export interface TeamProvisioningTransientRunStateServiceHostOptions extends Partial<
  Pick<TeamProvisioningTransientRunStatePorts, 'setTimeout' | 'clearTimeout' | 'nowMs'>
> {
  cancelPendingAutoResume: TeamProvisioningTransientRunStatePorts['cancelPendingAutoResume'];
  warn: TeamProvisioningTransientRunStatePorts['warn'];
}

export function createTeamProvisioningTransientRunStatePortsFromService(
  service: TeamProvisioningTransientRunStateServiceHost,
  options: TeamProvisioningTransientRunStateServiceHostOptions
): TeamProvisioningTransientRunStatePorts {
  return createTeamProvisioningTransientRunStatePorts({
    pendingTimeouts: service.pendingTimeouts,
    teamOpLocks: service.teamOpLocks,
    cancelPendingAutoResume: options.cancelPendingAutoResume,
    clearOpenCodeRuntimeToolApprovals: (teamName, clearOptions) =>
      service.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, clearOptions),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    clearRuntimeProcessRowsForTeam: (teamName) =>
      service.runtimeResourceSampling.clearRuntimeProcessRowsForTeam(teamName),
    retainedClaudeLogsByTeam: service.retainedClaudeLogsByTeam,
    persistedTranscriptClaudeLogs: {
      invalidate: (teamName) =>
        service.bootstrapTranscriptFacade.invalidatePersistedTranscriptClaudeLogs(teamName),
    },
    leadInboxRelayInFlight: service.leadInboxRelayInFlight,
    relayedLeadInboxMessageIds: service.relayedLeadInboxMessageIds,
    leadRecoveryMessageIds: service.leadRecoveryMessageIds,
    successfulLeadRecoveryMessageIds: service.successfulLeadRecoveryMessageIds,
    pendingCrossTeamFirstReplies: service.pendingCrossTeamFirstReplies,
    recentCrossTeamLeadDeliveryMessageIds: service.recentCrossTeamLeadDeliveryMessageIds,
    recentSameTeamNativeFingerprints: service.sameTeamNativeDelivery,
    memberInboxRelayInFlight: service.memberInboxRelayInFlight,
    openCodeMemberInboxRelayInFlight: service.openCodeMemberInboxRelayInFlight,
    openCodeMemberSendInFlightByLane: service.openCodeMemberSendInFlightByLane,
    openCodePromptDeliveryWatchdogScheduler: service.openCodePromptDeliveryWatchdogScheduler,
    openCodeRuntimeDeliveryAdvisory: service.openCodeRuntimeDeliveryAdvisory,
    relayedMemberInboxMessageIds: service.relayedMemberInboxMessageIds,
    liveLeadProcessMessages: service.liveLeadProcessMessages,
    relayLeadInboxMessages: (teamName) => service.relayLeadInboxMessages(teamName),
    warn: options.warn,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    nowMs: options.nowMs,
  });
}

export class TeamProvisioningTransientRunState {
  private readonly teamLockOwnership = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();
  private readonly activeTeamLockTokens = new Map<string, symbol>();

  constructor(private readonly ports: TeamProvisioningTransientRunStatePorts) {}

  clearSameTeamRetryTimers(teamName: string): void {
    for (const suffix of ['deferred', 'persist']) {
      const key = `same-team-${suffix}:${teamName}`;
      const timer = this.ports.pendingTimeouts.get(key);
      if (timer) {
        this.ports.clearTimeout(timer);
        this.ports.pendingTimeouts.delete(key);
      }
    }
  }

  clearLeadInboxFollowUpRelayTimer(teamName: string): void {
    const key = `lead-inbox-follow-up:${teamName}`;
    const timer = this.ports.pendingTimeouts.get(key);
    if (timer) {
      this.ports.clearTimeout(timer);
      this.ports.pendingTimeouts.delete(key);
    }
  }

  scheduleLeadInboxFollowUpRelay(teamName: string): void {
    const key = `lead-inbox-follow-up:${teamName}`;
    if (this.ports.pendingTimeouts.has(key)) return;

    const timer = this.ports.setTimeout(() => {
      this.ports.pendingTimeouts.delete(key);
      void this.ports
        .relayLeadInboxMessages(teamName)
        .catch((error: unknown) =>
          this.ports.warn(`[${teamName}] lead inbox follow-up relay failed: ${String(error)}`)
        );
    }, 50);
    timer.unref?.();
    this.ports.pendingTimeouts.set(key, timer);
  }

  resetTeamScopedTransientStateForNewRun(teamName: string): void {
    this.ports.cancelPendingAutoResume(teamName);
    this.ports.clearOpenCodeRuntimeToolApprovals(teamName, { emitDismiss: true });
    this.ports.invalidateRuntimeSnapshotCaches(teamName);
    this.ports.clearRuntimeProcessRowsForTeam(teamName);
    this.ports.retainedClaudeLogsByTeam.delete(teamName);
    this.ports.persistedTranscriptClaudeLogs.invalidate(teamName);
    this.ports.leadInboxRelayInFlight.delete(teamName);
    this.ports.relayedLeadInboxMessageIds.delete(teamName);
    this.ports.leadRecoveryMessageIds.delete(teamName);
    this.ports.successfulLeadRecoveryMessageIds.delete(teamName);
    this.ports.pendingCrossTeamFirstReplies.delete(teamName);
    this.ports.recentCrossTeamLeadDeliveryMessageIds.delete(teamName);
    this.ports.recentSameTeamNativeFingerprints.delete(teamName);
    this.clearSameTeamRetryTimers(teamName);
    this.clearLeadInboxFollowUpRelayTimer(teamName);

    deleteKeysWithPrefix(this.ports.memberInboxRelayInFlight, `${teamName}:`);
    deleteKeysWithPrefix(this.ports.openCodeMemberInboxRelayInFlight, `opencode:${teamName}:`);
    deleteKeysWithPrefix(this.ports.openCodeMemberSendInFlightByLane, `opencode-send:${teamName}:`);
    this.ports.openCodePromptDeliveryWatchdogScheduler.cancelTeam(teamName);
    this.ports.openCodeRuntimeDeliveryAdvisory.cancelTeam(teamName);
    deleteKeysWithPrefix(this.ports.relayedMemberInboxMessageIds, `${teamName}:`);

    this.ports.liveLeadProcessMessages.delete(teamName);
  }

  appendCliLogs(run: TeamProvisioningCliLogRun, stream: 'stdout' | 'stderr', text: string): void {
    run.claudeLogsUpdatedAt = new Date(this.ports.nowMs()).toISOString();

    const marker = stream === 'stdout' ? '[stdout]' : '[stderr]';
    if (run.lastClaudeLogStream !== stream) {
      run.lastClaudeLogStream = stream;
      run.claudeLogLines.push(marker);
    }

    if (stream === 'stdout') {
      run.stdoutLogLineBuf += text;
      const parts = run.stdoutLogLineBuf.split('\n');
      run.stdoutLogLineBuf = boundPendingLogLineCarry(parts.pop() ?? '');
      appendCompleteLogLines(run.claudeLogLines, parts);
    } else {
      run.stderrLogLineBuf += text;
      const parts = run.stderrLogLineBuf.split('\n');
      run.stderrLogLineBuf = boundPendingLogLineCarry(parts.pop() ?? '');
      appendCompleteLogLines(run.claudeLogLines, parts);
    }
    boundRunClaudeLogLines(run);
  }

  async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    const ownedTeamLocks = this.teamLockOwnership.getStore();
    const ownedToken = ownedTeamLocks?.get(teamName);
    if (ownedToken && this.activeTeamLockTokens.get(teamName) === ownedToken) {
      return fn();
    }

    const prev = this.ports.teamOpLocks.get(teamName);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.ports.teamOpLocks.set(teamName, mine);
    if (prev) {
      await prev;
    }
    const ownershipToken = Symbol(`team-lock:${teamName}`);
    this.activeTeamLockTokens.set(teamName, ownershipToken);
    try {
      const nextOwnedTeamLocks = new Map(ownedTeamLocks);
      nextOwnedTeamLocks.set(teamName, ownershipToken);
      return await this.teamLockOwnership.run(nextOwnedTeamLocks, fn);
    } finally {
      if (this.activeTeamLockTokens.get(teamName) === ownershipToken) {
        this.activeTeamLockTokens.delete(teamName);
      }
      release();
      if (this.ports.teamOpLocks.get(teamName) === mine) {
        this.ports.teamOpLocks.delete(teamName);
      }
    }
  }
}

function deleteKeysWithPrefix(map: PrefixScopedDeleteMap, prefix: string): void {
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(prefix)) {
      map.delete(key);
    }
  }
}

function appendCompleteLogLines(target: string[], parts: string[]): void {
  for (const part of parts) {
    const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
    target.push(boundSingleRetainedLogLine(normalized));
  }
}
