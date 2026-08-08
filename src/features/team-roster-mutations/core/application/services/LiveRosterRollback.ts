import { toRollbackReplaceMembersRequest } from '../../domain/liveRosterPolicy';

import type { RuntimeRosterMutationMember } from '../../domain/rosterMutationModels';
import type {
  TeamRosterCachePort,
  TeamRosterLifecyclePort,
  TeamRosterLoggerPort,
  TeamRosterMetadataPort,
  TeamRosterMutationRepositoryPort,
} from '../ports/TeamRosterMutationPorts';

export class LiveRosterRollback {
  constructor(
    private readonly dependencies: {
      repository: Pick<TeamRosterMutationRepositoryPort, 'replaceMembers'>;
      metadata: TeamRosterMetadataPort;
      lifecycle: Pick<TeamRosterLifecyclePort, 'attach' | 'detach'>;
      cache: TeamRosterCachePort;
      logger: TeamRosterLoggerPort;
    }
  ) {}

  async execute(options: {
    teamName: string;
    previousMembers: RuntimeRosterMutationMember[];
    previousMetadata: Awaited<ReturnType<TeamRosterMetadataPort['getSnapshot']>>;
    restoreLiveMemberNames?: string[];
    detachLiveMemberNames?: string[];
  }): Promise<void> {
    const { teamName, previousMembers, previousMetadata } = options;
    const detachNames = uniqueNames(options.detachLiveMemberNames ?? []);
    for (const memberName of detachNames) {
      try {
        await this.dependencies.lifecycle.detach(teamName, memberName);
      } catch (error) {
        this.dependencies.logger.warn(
          `Failed to clean up live roster member for ${teamName}/${memberName} during rollback: ${errorMessage(error)}`
        );
      }
    }

    const metadataRestored = await this.restoreMetadata({
      teamName,
      previousMembers,
      previousMetadata,
    });
    if (!metadataRestored) return;

    this.dependencies.cache.invalidate(teamName);
    for (const memberName of uniqueNames(options.restoreLiveMemberNames ?? [])) {
      try {
        await this.dependencies.lifecycle.attach(teamName, memberName, {
          reason: 'member_updated',
        });
      } catch (error) {
        this.dependencies.logger.warn(
          `Failed to restore live roster member for ${teamName}/${memberName} during rollback: ${errorMessage(error)}`
        );
      }
    }
  }

  private async restoreMetadata(options: {
    teamName: string;
    previousMembers: RuntimeRosterMutationMember[];
    previousMetadata: Awaited<ReturnType<TeamRosterMetadataPort['getSnapshot']>>;
  }): Promise<boolean> {
    if (options.previousMetadata) {
      try {
        await this.dependencies.metadata.writeSnapshot(options.teamName, options.previousMetadata);
        return true;
      } catch (error) {
        this.dependencies.logger.error(
          `Failed to restore exact live roster metadata for ${options.teamName}: ${errorMessage(error)}`
        );
      }
    }

    try {
      await this.dependencies.repository.replaceMembers(
        options.teamName,
        toRollbackReplaceMembersRequest(options.previousMembers)
      );
      return true;
    } catch (error) {
      this.dependencies.logger.error(
        `Failed to roll back fallback live roster metadata for ${options.teamName}: ${errorMessage(error)}`
      );
      return false;
    }
  }
}

function uniqueNames(names: string[]): string[] {
  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
