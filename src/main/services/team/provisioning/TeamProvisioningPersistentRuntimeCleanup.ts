import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';

export interface TeamProvisioningPersistentRuntimeCleanupLogger {
  warn(message: string): void;
}

export interface TeamProvisioningPersistentRuntimeCleanupPorts {
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): void;
  killOrphanedTeamAgentProcesses(teamName: string, currentRunPid: number | undefined): void;
  getCurrentRunPid(teamName: string): number | undefined;
  cleanupAnthropicTeamApiKeyHelperForTeam(input: {
    teamName: string;
    baseClaudeDir: string;
  }): Promise<void>;
  getClaudeBasePath(): string;
  logger: TeamProvisioningPersistentRuntimeCleanupLogger;
}

export interface TeamProvisioningPersistentRuntimeCleanup {
  stopPersistentTeamMembers(teamName: string): void;
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName: string): Promise<void>;
}

export function createTeamProvisioningPersistentRuntimeCleanup(
  ports: TeamProvisioningPersistentRuntimeCleanupPorts
): TeamProvisioningPersistentRuntimeCleanup {
  return {
    stopPersistentTeamMembers(teamName) {
      const members = ports.readPersistedRuntimeMembers(teamName);
      if (members.length > 0) {
        ports.killPersistedPaneMembers(teamName, members);
      }
      ports.killOrphanedTeamAgentProcesses(teamName, ports.getCurrentRunPid(teamName));
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
