import type { TeamRosterMember } from '../../domain/messageDeliveryModels';
import type {
  DurableTeamRosterPort,
  TeamMessageLoggerPort,
} from '../ports/TeamMessageDeliveryPorts';

export class DurableLeadRosterReader {
  constructor(
    private readonly dependencies: {
      roster: DurableTeamRosterPort;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async read(teamName: string, leadName: string): Promise<TeamRosterMember[]> {
    const leadLower = normalizeName(leadName);
    const reserved = new Set(['team-lead', 'user', leadLower].filter(Boolean));
    try {
      const teammates = normalizeRoster(
        await this.dependencies.roster.getMembers(teamName),
        reserved
      );
      if (teammates.length > 0) return teammates;
    } catch (error) {
      this.dependencies.logger.debug(
        `[teams:sendMessage] Failed to read members.meta roster for "${teamName}": ${errorMessage(error)}`
      );
    }
    try {
      return normalizeRoster(await this.dependencies.roster.getFallbackMembers(teamName), reserved);
    } catch (error) {
      this.dependencies.logger.debug(
        `[teams:sendMessage] Failed to read fallback team roster for "${teamName}": ${errorMessage(error)}`
      );
      return [];
    }
  }
}

function normalizeRoster(
  members: TeamRosterMember[],
  reserved: ReadonlySet<string>
): TeamRosterMember[] {
  return members
    .filter((member) => !member.removedAt)
    .filter((member) => {
      const lower = normalizeName(member.name);
      return lower.length > 0 && !reserved.has(lower);
    })
    .map((member) => ({
      name: member.name.trim(),
      role:
        typeof member.role === 'string' && member.role.trim().length > 0
          ? member.role.trim()
          : undefined,
    }));
}

function normalizeName(name: string | undefined | null): string {
  return name?.trim().toLowerCase() ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
