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
    knownPids: readonly number[]
  ): PersistentRuntimeStopVerdict;
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

export function createTeamProvisioningPersistentRuntimeCleanup(
  ports: TeamProvisioningPersistentRuntimeCleanupPorts
): TeamProvisioningPersistentRuntimeCleanup {
  const confirmedStops = new Map<string, boolean>();
  const stopReasons = new Map<string, PersistentRuntimeStopReason>();
  const stopPersistentTeamMembers = (teamName: string): boolean => {
    confirmedStops.set(teamName, false);
    stopReasons.delete(teamName);
    const members = ports.readPersistedRuntimeMembers(teamName);
    const panes =
      members.length > 0
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
    const processes = ports.killOrphanedTeamAgentProcesses(
      teamName,
      ports.getCurrentRunPid(teamName),
      recordedPids
    );
    const confirmed = panes.confirmed && processes.confirmed;
    confirmedStops.set(teamName, confirmed);
    if (!confirmed) {
      const reason: PersistentRuntimeStopReason = !panes.confirmed
        ? (panes.reason ?? 'pane_kill_failed')
        : (processes.reason ?? 'process_table_unreadable');
      stopReasons.set(teamName, reason);
    }
    return confirmed;
  };
  return {
    stopPersistentTeamMembers,

    async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName) {
      // A dispatched kill is not proof of exit (fire-and-forget on Windows) and
      // the scan runs before the lane stops settle, so an unconfirmed dispatch
      // is re-checked here: this cleanup runs when the explicit stop completed,
      // and only leftovers that are still live keep the stop unconfirmed.
      if (confirmedStops.get(teamName) === false) {
        const delay = ports.sleep ?? sleep;
        let confirmed = false;
        for (let attempt = 1; attempt <= STOP_CONFIRMATION_RECHECKS; attempt += 1) {
          // Each re-check first lets the previous kill dispatch settle and gives
          // the process-table probe a fresh try, so only leftovers that survive
          // the whole bounded window are reported as still live.
          await delay(STOP_CONFIRMATION_RECHECK_BACKOFF_MS * attempt);
          confirmed = stopPersistentTeamMembers(teamName);
          if (confirmed) break;
        }
        if (!confirmed) {
          throw new Error(
            `[${teamName}] Persistent runtime termination could not be confirmed: ${
              stopReasons.get(teamName) ?? 'process_table_unreadable'
            }`
          );
        }
      }
      if (confirmedStops.get(teamName) === true) {
        // StopFlow calls this only after its tracked lead/lane stops also settle.
        // Persist gateway terminal facts while launch discovery is still available.
        await ports.confirmNativeTeamStopped?.(teamName);
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
