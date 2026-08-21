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
  logger: TeamProvisioningPersistentRuntimeCleanupLogger;
}

export interface TeamProvisioningPersistentRuntimeCleanup {
  stopPersistentTeamMembers(teamName: string): boolean;
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName: string): Promise<void>;
}

export function createTeamProvisioningPersistentRuntimeCleanup(
  ports: TeamProvisioningPersistentRuntimeCleanupPorts
): TeamProvisioningPersistentRuntimeCleanup {
  return {
    stopPersistentTeamMembers(teamName) {
      const members = ports.readPersistedRuntimeMembers(teamName);
      let panesConfirmed = true;
      if (members.length > 0) {
        panesConfirmed = ports.killPersistedPaneMembers(teamName, members);
      }
      const processesConfirmed = ports.killOrphanedTeamAgentProcesses(
        teamName,
        ports.getCurrentRunPid(teamName)
      );
      return panesConfirmed && processesConfirmed;
    },

    async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName) {
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
