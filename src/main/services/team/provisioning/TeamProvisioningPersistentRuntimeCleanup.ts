import { sleep } from './TeamProvisioningAsyncUtils';

import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export type PersistentRuntimeStopReason =
  | 'pane_kill_failed'
  | 'process_table_unreadable'
  | 'live_agent_processes';

export interface PersistentRuntimeStopVerdict {
  confirmed: boolean;
  reason?: PersistentRuntimeStopReason;
}

export interface PendingPersistentProcessStop {
  stopNewProcesses(currentRunPid: number | undefined): void;
  confirmStopped(): Promise<boolean>;
}

export interface TeamProvisioningPersistentRuntimeCleanupLogger {
  warn(message: string): void;
}

const STOP_CONFIRMATION_RECHECKS = 4;
const STOP_CONFIRMATION_RECHECK_BACKOFF_MS = 400;

export interface TeamProvisioningPersistentRuntimeCleanupPorts {
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  /** Recorded runtime pids from launch discovery - config members rarely carry any. */
  readRecordedRuntimePids?(teamName: string): readonly number[];
  killPersistedPaneMembers(
    teamName: string,
    members: PersistedRuntimeMemberLike[]
  ): PersistentRuntimeStopVerdict;
  killOrphanedTeamAgentProcesses(
    teamName: string,
    currentRunPid: number | undefined,
    knownPids: readonly number[],
    options?: { isRecheck?: boolean }
  ): PersistentRuntimeStopVerdict | PendingPersistentProcessStop;
  getCurrentRunPid(teamName: string): number | undefined;
  cleanupAnthropicTeamApiKeyHelperForTeam(input: {
    teamName: string;
    baseClaudeDir: string;
  }): Promise<void>;
  getClaudeBasePath(): string;
  clearPersistedLiveRuntimeHandles?(teamName: string): boolean;
  sleep?: (ms: number) => Promise<void>;
  confirmNativeTeamStopped?(teamName: string): Promise<void>;
  logger: TeamProvisioningPersistentRuntimeCleanupLogger;
}

export interface TeamProvisioningPersistentRuntimeCleanup {
  stopPersistentTeamMembers(teamName: string): boolean;
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName: string): Promise<void>;
}

export function isPendingPersistentProcessStop(
  value: PersistentRuntimeStopVerdict | PendingPersistentProcessStop
): value is PendingPersistentProcessStop {
  return 'confirmStopped' in value && 'stopNewProcesses' in value;
}

export function createTeamProvisioningPersistentRuntimeCleanup(
  ports: TeamProvisioningPersistentRuntimeCleanupPorts
): TeamProvisioningPersistentRuntimeCleanup {
  interface StopConfirmation {
    confirmed: boolean;
    panesConfirmed: boolean;
    pending?: PendingPersistentProcessStop;
    reason?: PersistentRuntimeStopReason;
  }
  const confirmedStops = new Map<string, StopConfirmation>();
  const stopPersistentTeamMembers = (
    teamName: string,
    options: { killPanes?: boolean; isRecheck?: boolean } = {}
  ): boolean => {
    const previous = confirmedStops.get(teamName);
    const stop: StopConfirmation = { confirmed: false, panesConfirmed: false };
    confirmedStops.set(teamName, stop);
    const members = ports.readPersistedRuntimeMembers(teamName);
    // A settled pane kill must not be replayed: the pane id stays persisted until
    // the whole stop confirms, and a replayed kill of a gone pane reports a false
    // pane_kill_failed that keeps the stop unconfirmed forever.
    const panes =
      options.killPanes === false && previous?.panesConfirmed
        ? ({ confirmed: true } satisfies PersistentRuntimeStopVerdict)
        : members.length > 0
          ? ports.killPersistedPaneMembers(teamName, members)
          : ({ confirmed: true } satisfies PersistentRuntimeStopVerdict);
    const memberPids = members.flatMap((member) =>
      typeof member.runtimePid === 'number' && Number.isFinite(member.runtimePid)
        ? [member.runtimePid]
        : []
    );
    const recordedPids = [
      ...new Set([...(ports.readRecordedRuntimePids?.(teamName) ?? []), ...memberPids]),
    ];
    // Extend the existing capture on explicit Stop without replaying sent signals.
    previous?.pending?.stopNewProcesses(ports.getCurrentRunPid(teamName));
    const processes =
      previous?.pending ??
      ports.killOrphanedTeamAgentProcesses(
        teamName,
        ports.getCurrentRunPid(teamName),
        recordedPids,
        ...(options.isRecheck ? [{ isRecheck: true } as const] : [])
      );
    stop.panesConfirmed = panes.confirmed;
    if (isPendingPersistentProcessStop(processes)) {
      stop.pending = processes;
    } else {
      stop.confirmed = panes.confirmed && processes.confirmed;
    }
    if (!stop.confirmed) {
      stop.reason = !panes.confirmed
        ? (panes.reason ?? 'pane_kill_failed')
        : isPendingPersistentProcessStop(processes)
          ? 'live_agent_processes'
          : (processes.reason ?? 'process_table_unreadable');
    }
    return stop.confirmed;
  };
  return {
    stopPersistentTeamMembers,

    async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName) {
      let stop = confirmedStops.get(teamName);
      if (stop?.pending && stop.panesConfirmed) {
        stop.confirmed = await stop.pending.confirmStopped();
        if (confirmedStops.get(teamName) !== stop) {
          throw new Error(`[${teamName}] Persistent runtime stop ownership changed`);
        }
        if (!stop.confirmed) stop.reason = 'live_agent_processes';
      }
      if (stop && !stop.confirmed && !stop.pending) {
        // A dispatched kill is not proof of exit (fire-and-forget on Windows) and
        // the scan runs before the lane stops settle, so an unconfirmed dispatch
        // is re-checked here: this cleanup runs when the explicit stop completed,
        // and only leftovers that are still live keep the stop unconfirmed.
        const delay = ports.sleep ?? sleep;
        for (let attempt = 1; attempt <= STOP_CONFIRMATION_RECHECKS; attempt += 1) {
          // Each re-check first lets the previous kill dispatch settle and gives
          // the process-table probe a fresh try, so only leftovers that survive
          // the whole bounded window are reported as still live.
          await delay(STOP_CONFIRMATION_RECHECK_BACKOFF_MS * attempt);
          if (confirmedStops.get(teamName) !== stop) {
            throw new Error(`[${teamName}] Persistent runtime stop ownership changed`);
          }
          const confirmed = stopPersistentTeamMembers(teamName, {
            killPanes: !stop.panesConfirmed,
            isRecheck: true,
          });
          stop = confirmedStops.get(teamName) ?? stop;
          if (confirmed) break;
        }
      }
      if (stop && !stop.confirmed) {
        throw new Error(
          `[${teamName}] Persistent runtime termination could not be confirmed: ${
            stop.reason ?? 'process_table_unreadable'
          }`
        );
      }
      if (stop?.confirmed) {
        // StopFlow calls this only after its tracked lead/lane stops also settle.
        // Persist gateway terminal facts while launch discovery is still available.
        await ports.confirmNativeTeamStopped?.(teamName);
        if (confirmedStops.get(teamName) !== stop) {
          throw new Error(`[${teamName}] Persistent runtime stop ownership changed`);
        }
        try {
          ports.clearPersistedLiveRuntimeHandles?.(teamName);
        } catch (error) {
          ports.logger.warn(
            `[${teamName}] Failed to clear persisted live runtime handles: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        confirmedStops.delete(teamName);
      }
      try {
        await ports.cleanupAnthropicTeamApiKeyHelperForTeam({
          teamName,
          baseClaudeDir: ports.getClaudeBasePath(),
        });
      } catch (error) {
        ports.logger.warn(
          `[${teamName}] Failed to cleanup Anthropic team API-key helper material: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        throw error;
      }
    },
  };
}
