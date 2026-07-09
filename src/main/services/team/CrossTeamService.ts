import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE, formatCrossTeamText } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';

import { buildActionModeAgentBlock } from './actionModeInstructions';
import { CascadeGuard } from './CascadeGuard';
import { CrossTeamOutbox } from './CrossTeamOutbox';

import type { TeamCrossTeamMessagingApi } from './contracts/TeamProvisioningApis';
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
type AgentTeamsController = ReturnType<typeof createController>;

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

function resolveCrossTeamTargetMember(
  config: TeamConfig,
  rawToMember: string | undefined,
  fallbackLeadName: string
): string {
  const requestedKey = normalizeMemberKey(rawToMember);
  if (!requestedKey) {
    return fallbackLeadName;
  }

  const members = Array.isArray(config.members) ? config.members : [];
  const direct = members.find((member) => normalizeMemberKey(member.name) === requestedKey);
  if (direct?.name?.trim()) {
    return direct.name.trim();
  }

  const leadKey = normalizeMemberKey(fallbackLeadName);
  if (requestedKey === 'lead' || requestedKey === 'team-lead' || requestedKey === leadKey) {
    return fallbackLeadName;
  }

  throw new Error(`Unknown toMember: ${rawToMember}. Use a configured target team member name.`);
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

export class CrossTeamService {
  private cascadeGuard = new CascadeGuard();
  private outbox = new CrossTeamOutbox();

  constructor(
    private configReader: TeamConfigReader,
    private dataService: TeamDataService,
    private inboxWriter: TeamInboxWriter,
    private messaging: TeamCrossTeamMessagingApi | null
  ) {}

  async send(request: CrossTeamSendRequest): Promise<CrossTeamSendResult> {
    const { fromTeam, toTeam, toMember, text, taskRefs, summary, actionMode } = request;
    const rawFromMember = request.fromMember;
    const chainDepth = request.chainDepth ?? 0;
    const messageId = request.messageId?.trim() || randomUUID();
    const timestamp = request.timestamp ?? new Date().toISOString();
    const inferredReplyMeta =
      !request.conversationId && !request.replyToConversationId
        ? (this.messaging?.resolveCrossTeamReplyMetadata(fromTeam, toTeam) ?? null)
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
    const stableDedupeIdentity = Boolean(
      request.messageId?.trim() || request.conversationId?.trim()
    );

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
    const targetMemberName = resolveCrossTeamTargetMember(targetConfig, toMember, leadName);

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
      toMember: targetMemberName,
      conversationId,
      replyToConversationId,
      text,
      taskRefs,
      summary,
      chainDepth,
      timestamp,
    };

    const { duplicate } = await this.outbox.appendIfNotRecent(
      fromTeam,
      outboxMessage,
      async () => {
        // 4. Cascade check only for real new deliveries
        this.cascadeGuard.check(fromTeam, toTeam, chainDepth);
        this.cascadeGuard.record(fromTeam, toTeam);
        this.messaging?.registerPendingCrossTeamReplyExpectation(fromTeam, toTeam, conversationId);

        // 5. Inbox write to TARGET team (TeamInboxWriter handles file lock + in-process lock internally)
        await this.inboxWriter.sendMessage(toTeam, {
          member: targetMemberName,
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
      },
      undefined,
      { stableIdentity: stableDedupeIdentity }
    );

    if (duplicate) {
      const duplicateTargetMemberName = duplicate.toMember ?? targetMemberName;
      const result: CrossTeamSendResult = {
        messageId: duplicate.messageId,
        deliveredToInbox: true,
        deduplicated: true,
        toTeam: duplicate.toTeam,
        toMember: duplicateTargetMemberName,
      };
      if (request.requireRuntimeDelivery) {
        await this.requireCrossTeamRuntimeDelivery({
          teamName: toTeam,
          memberName: duplicateTargetMemberName,
          messageId: result.messageId,
        });
        this.appendSenderCopy({
          fromTeam: duplicate.fromTeam,
          fromMember: duplicate.fromMember,
          toTeam: duplicate.toTeam,
          targetMemberName: duplicateTargetMemberName,
          text: duplicate.text,
          taskRefs: duplicate.taskRefs,
          timestamp: duplicate.timestamp,
          messageId: duplicate.messageId,
          summary: duplicate.summary,
          conversationId: duplicate.conversationId ?? conversationId,
          replyToConversationId: duplicate.replyToConversationId ?? replyToConversationId,
        });
      }
      return result;
    }

    if (request.requireRuntimeDelivery) {
      await this.requireCrossTeamRuntimeDelivery({
        teamName: toTeam,
        memberName: targetMemberName,
        messageId,
      });
      this.appendSenderCopy({
        fromTeam,
        fromMember,
        toTeam,
        targetMemberName,
        text,
        taskRefs,
        timestamp,
        messageId,
        summary,
        conversationId,
        replyToConversationId,
      });
      return { messageId, deliveredToInbox: true, toTeam, toMember: targetMemberName };
    }

    // 6. Write a non-actionable sender copy so the message appears in activity without
    // waking the local lead through their inbox controller.
    this.appendSenderCopy({
      fromTeam,
      fromMember,
      toTeam,
      targetMemberName,
      text,
      taskRefs,
      timestamp,
      messageId,
      summary,
      conversationId,
      replyToConversationId,
    });

    // 7. Best-effort relay (if online)
    if (this.messaging?.isTeamAlive(toTeam)) {
      void this.messaging.relayLeadInboxMessages(toTeam).catch((e: unknown) => {
        logger.warn(`Cross-team relay to ${toTeam}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    return { messageId, deliveredToInbox: true, toTeam, toMember: targetMemberName };
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
          isOnline: this.messaging?.isTeamAlive(team.teamName) ?? false,
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

  private async requireCrossTeamRuntimeDelivery(input: {
    teamName: string;
    memberName: string;
    messageId: string;
  }): Promise<void> {
    if (!this.messaging) {
      throw new Error('Cross-team runtime delivery guard is not configured');
    }

    const relay = await this.messaging.relayInboxFileToLiveRecipient(
      input.teamName,
      input.memberName,
      { onlyMessageId: input.messageId }
    );
    if (hasRuntimeDeliveryProof(relay)) {
      return;
    }

    throw new Error(
      `Cross-team runtime delivery was not confirmed for ${input.teamName}.${input.memberName}: ` +
        describeRuntimeDeliveryRelay(relay)
    );
  }

  private appendSenderCopy(input: {
    fromTeam: string;
    fromMember: string;
    toTeam: string;
    targetMemberName: string;
    text: string;
    taskRefs: CrossTeamSendRequest['taskRefs'];
    timestamp: string;
    messageId: string;
    summary: CrossTeamSendRequest['summary'];
    conversationId: string;
    replyToConversationId: string | undefined;
  }): void {
    try {
      const controller = createController({
        teamName: input.fromTeam,
        claudeDir: getClaudeBasePath(),
      });
      if (!hasExistingSentCopy(controller, input.messageId)) {
        controller.messages.appendSentMessage({
          from: input.fromMember,
          to: `${input.toTeam}.${input.targetMemberName}`,
          text: input.text,
          taskRefs: input.taskRefs,
          timestamp: input.timestamp,
          messageId: input.messageId,
          summary: input.summary ?? `Cross-team message to ${input.toTeam}`,
          source: CROSS_TEAM_SENT_SOURCE,
          conversationId: input.conversationId,
          replyToConversationId: input.replyToConversationId,
        });
      }
      this.messaging?.clearPendingCrossTeamReplyExpectation(
        input.fromTeam,
        input.toTeam,
        input.conversationId
      );
    } catch (e: unknown) {
      logger.warn(
        `Failed to write sender copy for ${input.fromTeam}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
}

function hasRuntimeDeliveryProof(
  relay: Awaited<ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>>
): boolean {
  if (relay.kind === 'native_lead') {
    return relay.relayed > 0;
  }

  if (relay.kind !== 'opencode_member') {
    return false;
  }

  if (relay.relayed > 0) {
    return true;
  }

  const delivery = relay.lastDelivery;
  return Boolean(
    delivery?.delivered &&
    delivery.accepted === true &&
    !delivery.acceptanceUnknown &&
    !delivery.queuedBehindMessageId
  );
}

function hasExistingSentCopy(controller: AgentTeamsController, messageId: string): boolean {
  try {
    return controller.messages.lookupMessage(messageId).store === 'sent';
  } catch {
    return false;
  }
}

function describeRuntimeDeliveryRelay(
  relay: Awaited<ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>>
): string {
  const diagnostics = relay.diagnostics?.filter(Boolean) ?? [];
  const lastDelivery = relay.lastDelivery;
  const reason = lastDelivery?.reason;
  return reason || diagnostics[0] || `relay kind ${relay.kind} relayed ${relay.relayed}`;
}
