import type {
  OrganizationsCrossTeamMessagePort,
  OrganizationsLoggerPort,
} from '../../../core/application';
import type { CrossTeamMessageCandidate } from '../../../core/domain';
import type { CrossTeamService } from '@main/services/team/CrossTeamService';
import type { CrossTeamMessage } from '@shared/types';

const CROSS_TEAM_OUTBOX_CONCURRENCY = 8;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await mapper(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function toCandidate(message: CrossTeamMessage): CrossTeamMessageCandidate {
  return {
    messageId: message.messageId,
    fromTeam: message.fromTeam,
    toTeam: message.toTeam,
    text: message.text,
    summary: message.summary,
    conversationId: message.conversationId,
    timestamp: message.timestamp,
  };
}

function getTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class CrossTeamOrganizationAdapter implements OrganizationsCrossTeamMessagePort {
  constructor(
    private readonly crossTeamService: CrossTeamService,
    private readonly logger: OrganizationsLoggerPort
  ) {}

  async listRecentMessages(input: {
    teamNames: readonly string[];
    maxMessages: number;
  }): Promise<CrossTeamMessageCandidate[]> {
    const visibleTeamNames = new Set(input.teamNames);
    const batches = await mapLimit(
      input.teamNames,
      CROSS_TEAM_OUTBOX_CONCURRENCY,
      async (teamName) => {
        try {
          return await this.crossTeamService.getOutbox(teamName);
        } catch (error) {
          this.logger.warn('organizations skipped cross-team outbox', {
            teamName,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }
    );

    return batches
      .flat()
      .map(toCandidate)
      .filter(
        (message) => visibleTeamNames.has(message.fromTeam) && visibleTeamNames.has(message.toTeam)
      )
      .sort((left, right) => getTimestampMs(right.timestamp) - getTimestampMs(left.timestamp))
      .slice(0, input.maxMessages);
  }
}
