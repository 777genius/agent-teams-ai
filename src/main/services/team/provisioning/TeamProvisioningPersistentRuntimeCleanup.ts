import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export interface PendingPersistentProcessStop {
  confirmStopped(): Promise<boolean>;
}

export interface TeamProvisioningPersistentRuntimeCleanupLogger {
  warn(message: string): void;
}

export interface TeamProvisioningPersistentRuntimeCleanupPorts {
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): boolean;
  killOrphanedTeamAgentProcesses(
    teamName: string,
    currentRunPid: number | undefined
  ): boolean | PendingPersistentProcessStop;
  getCurrentRunPid(teamName: string): number | undefined;
  cleanupAnthropicTeamApiKeyHelperForTeam(input: {
    teamName: string;
    baseClaudeDir: string;
  }): Promise<void>;
  getClaudeBasePath(): string;
  clearPersistedLiveRuntimeHandles?(teamName: string): boolean;
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
  interface StopConfirmation {
    confirmed: boolean;
    panesConfirmed: boolean;
    pending?: PendingPersistentProcessStop;
  }
  const confirmedStops = new Map<string, StopConfirmation>();
  return {
    stopPersistentTeamMembers(teamName) {
      const previous = confirmedStops.get(teamName);
      const stop: StopConfirmation = { confirmed: false, panesConfirmed: false };
      confirmedStops.set(teamName, stop);
      const members = ports.readPersistedRuntimeMembers(teamName);
      let panesConfirmed = true;
      if (members.length > 0) {
        panesConfirmed = ports.killPersistedPaneMembers(teamName, members);
      }
      // An outstanding receipt owns descendants even after its matching root exits.
      // Retry observes that same capture; it cannot forget it or replay its signals.
      const processesConfirmed =
        previous?.pending ??
        ports.killOrphanedTeamAgentProcesses(teamName, ports.getCurrentRunPid(teamName));
      stop.panesConfirmed = panesConfirmed;
      stop.confirmed = panesConfirmed && processesConfirmed === true;
      if (typeof processesConfirmed !== 'boolean') stop.pending = processesConfirmed;
      return stop.confirmed;
    },

    async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName) {
      const stop = confirmedStops.get(teamName);
      if (stop?.pending && stop.panesConfirmed) {
        stop.confirmed = await stop.pending.confirmStopped();
        if (confirmedStops.get(teamName) !== stop) {
          throw new Error(`[${teamName}] Persistent runtime stop ownership changed`);
        }
      }
      if (stop && !stop.confirmed) {
        throw new Error(`[${teamName}] Persistent runtime termination could not be confirmed`);
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
