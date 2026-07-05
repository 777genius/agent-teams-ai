import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE, formatCrossTeamText } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';

import { buildActionModeAgentBlock } from './actionModeInstructions';
import { CascadeGuard } from './CascadeGuard';
import { CrossTeamOutbox } from './CrossTeamOutbox';

import type { TeamConfigReader } from './TeamConfigReader';
import type { TeamDataService } from './TeamDataService';
import type { TeamInboxWriter } from './TeamInboxWriter';
import type {
  CrossTeamMessage,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  TeamConfig,
} from '@shared/types';

const logger = createLogger('CrossTeamService');
const { createController } = agentTeamsControllerModule;

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

function normalizeMemberKey(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : '';
}

function resolveCrossTeamFromMember(config: TeamConfig, rawFromMember: string): string {
  const members = Array.isArray(config.members) ? config.members : [];
  const rawKey = normalizeMemberKey(rawFromMember);
  const direct = members.find((member) => normalizeMemberKey(member.name) === rawKey);
  if (direct?.name?.trim()) {
    return direct.name.trim();
  }

  const lead = members.find((member) => isLeadMember(member)) ?? members[0];
  const leadName = lead?.name?.trim();
  const leadKey = normalizeMemberKey(leadName);
  if (leadName && (rawKey === 'lead' || rawKey === 'team-lead' || rawKey === leadKey)) {
    return leadName;
  }

  throw new Error(`Unknown fromMember: ${rawFromMember}. Use a configured team member name.`);
}

export interface CrossTeamTarget {
  teamName: string;
  displayName: string;
  description?: string;
  color?: string;
  leadName?: string;
  leadColor?: string;
  isOnline?: boolean;
}

interface CrossTeamProvisioningPort {
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void;
  isTeamAlive(teamName: string): boolean;
  relayLeadInboxMessages(teamName: string): Promise<unknown>;
}

export class CrossTeamService {
  private cascadeGuard = new CascadeGuard();
  private outbox = new CrossTeamOutbox();

  constructor(
    private configReader: TeamConfigReader,
    private dataService: TeamDataService,
    private inboxWriter: TeamInboxWriter,
    private provisioning: CrossTeamProvisioningPort | null
  ) {}

  async send(request: CrossTeamSendRequest): Promise<CrossTeamSendResult> {
    const { fromTeam, toTeam, text, taskRefs, summary, actionMode } = request;
    const rawFromMember = request.fromMember;
    const chainDepth = request.chainDepth ?? 0;
    const messageId = request.messageId?.trim() || randomUUID();
    const timestamp = request.timestamp ?? new Date().toISOString();
    const inferredReplyMeta =
      !request.conversationId && !request.replyToConversationId
        ? (this.provisioning?.resolveCrossTeamReplyMetadata(fromTeam, toTeam) ?? null)
        : null;
    const replyToConversationId =
      request.replyToConversationId?.trim() ||
      inferredReplyMeta?.replyToConversationId ||
      undefined;
    const conversationId =
      request.conversationId?.trim() ||
      inferredReplyMeta?.conversationId ||
      replyToConversationId ||
      randomUUID();

    // 1. Validate
    if (!TEAM_NAME_PATTERN.test(fromTeam)) {
      throw new Error(`Invalid fromTeam: ${fromTeam}`);
    }
    if (!TEAM_NAME_PATTERN.test(toTeam)) {
      throw new Error(`Invalid toTeam: ${toTeam}`);
    }
    if (fromTeam === toTeam) {
      throw new Error('Cannot send cross-team message to the same team');
    }
    if (!rawFromMember || typeof rawFromMember !== 'string' || rawFromMember.trim().length === 0) {
      throw new Error('fromMember is required');
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Message text is required');
    }

    const sourceConfig = await this.configReader.getConfig(fromTeam);
    if (!sourceConfig || sourceConfig.deletedAt) {
      throw new Error(`Source team not found: ${fromTeam}`);
    }
    const fromMember = resolveCrossTeamFromMember(sourceConfig, rawFromMember.trim());

    const targetConfig = await this.configReader.getConfig(toTeam);
    if (!targetConfig || targetConfig.deletedAt) {
      throw new Error(`Target team not found: ${toTeam}`);
    }

    // 2. Resolve lead. Reuse the verified target config before falling back to meta storage.
    const leadName =
      targetConfig.members?.find((m) => isLeadMember(m))?.name?.trim() ||
      (await this.dataService.getLeadMemberName(toTeam)) ||
      'team-lead';

    // 3. Format
    const from = `${fromTeam}.${fromMember}`;
    const actionModeBlock = buildActionModeAgentBlock(actionMode);
    const deliveryText = actionModeBlock ? `${actionModeBlock}\n\n${text}` : text;
    const formattedText = formatCrossTeamText(from, chainDepth, deliveryText, {
      conversationId,
      replyToConversationId,
    });
    const outboxMessage: CrossTeamMessage = {
      messageId,
      fromTeam,
      fromMember,
      toTeam,
      conversationId,
      replyToConversationId,
      text,
      taskRefs,
      summary,
      chainDepth,
      timestamp,
    };

    const { duplicate } = await this.outbox.appendIfNotRecent(fromTeam, outboxMessage, async () => {
      // 4. Cascade check only for real new deliveries
      this.cascadeGuard.check(fromTeam, toTeam, chainDepth);
      this.cascadeGuard.record(fromTeam, toTeam);
      this.provisioning?.registerPendingCrossTeamReplyExpectation(fromTeam, toTeam, conversationId);

      // 5. Inbox write to TARGET team (TeamInboxWriter handles file lock + in-process lock internally)
      await this.inboxWriter.sendMessage(toTeam, {
        member: leadName,
        text: formattedText,
        from,
        timestamp,
        messageId,
        summary: summary ?? `Cross-team message from ${fromTeam}`,
        source: CROSS_TEAM_SOURCE,
        conversationId,
        replyToConversationId,
        taskRefs,
      });
    });

    if (duplicate) {
      return { messageId: duplicate.messageId, deliveredToInbox: true, deduplicated: true };
    }

    // 6. Write a non-actionable sender copy so the message appears in activity without
    // waking the local lead through their inbox controller.
    try {
      createController({
        teamName: fromTeam,
        claudeDir: getClaudeBasePath(),
      }).messages.appendSentMessage({
        from: fromMember,
        to: `${toTeam}.${leadName}`,
        text,
        taskRefs,
        timestamp,
        messageId,
        summary: summary ?? `Cross-team message to ${toTeam}`,
        source: CROSS_TEAM_SENT_SOURCE,
        conversationId,
        replyToConversationId,
      });
      this.provisioning?.clearPendingCrossTeamReplyExpectation(fromTeam, toTeam, conversationId);
    } catch (e: unknown) {
      logger.warn(
        `Failed to write sender copy for ${fromTeam}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // 7. Best-effort relay (if online)
    if (this.provisioning?.isTeamAlive(toTeam)) {
      void this.provisioning.relayLeadInboxMessages(toTeam).catch((e: unknown) => {
        logger.warn(`Cross-team relay to ${toTeam}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    return { messageId, deliveredToInbox: true };
  }

  async listAvailableTargets(excludeTeam?: string): Promise<CrossTeamTarget[]> {
    let teams: Awaited<ReturnType<TeamDataService['listTeams']>>;
    try {
      teams = await this.dataService.listTeams();
    } catch {
      return [];
    }

    const targets: CrossTeamTarget[] = teams
      .filter((team) => {
        if (excludeTeam && team.teamName === excludeTeam) return false;
        if (!TEAM_NAME_PATTERN.test(team.teamName)) return false;
        return !team.deletedAt && !team.pendingCreate;
      })
      .map((team) => {
        const summaryLead =
          team.leadName || team.leadColor
            ? { name: team.leadName, color: team.leadColor }
            : team.members?.find((member) => isLeadMember(member));
        return {
          teamName: team.teamName,
          displayName: team.displayName || team.teamName,
          description: team.description,
          color: team.color,
          ...(summaryLead?.name ? { leadName: summaryLead.name } : {}),
          ...(summaryLead?.color ? { leadColor: summaryLead.color } : {}),
          isOnline: this.provisioning?.isTeamAlive(team.teamName) ?? false,
        };
      });

    return targets.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });
  }

  async getOutbox(teamName: string): Promise<CrossTeamMessage[]> {
    return this.outbox.read(teamName);
  }
}
