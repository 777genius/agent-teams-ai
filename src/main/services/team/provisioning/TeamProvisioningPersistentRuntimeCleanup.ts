import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export interface TeamProvisioningPersistentRuntimeCleanupLogger {
  warn(message: string): void;
}

export interface TeamProvisioningPersistentRuntimeCleanupPorts {
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): boolean;
  killOrphanedTeamAgentProcesses(teamName: string, currentRunPid: number | undefined): boolean;
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
  const confirmedStops = new Map<string, boolean>();
  return {
    stopPersistentTeamMembers(teamName) {
      confirmedStops.set(teamName, false);
      const members = ports.readPersistedRuntimeMembers(teamName);
      let panesConfirmed = true;
      if (members.length > 0) {
        panesConfirmed = ports.killPersistedPaneMembers(teamName, members);
      }
      const processesConfirmed = ports.killOrphanedTeamAgentProcesses(
        teamName,
        ports.getCurrentRunPid(teamName)
      );
      const confirmed = panesConfirmed && processesConfirmed;
      confirmedStops.set(teamName, confirmed);
      return confirmed;
    },

    async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName) {
      if (confirmedStops.get(teamName) === false) {
        throw new Error(`[${teamName}] Persistent runtime termination could not be confirmed`);
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
