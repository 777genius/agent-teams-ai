import {
  assertCrossTeamSender,
  createAppCrossTeamRecipientPorts,
  findProjectCopyOwner,
  projectTeamSummaries,
  resolveCrossTeamRecipient,
} from '@features/team-project-context/main';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE, formatCrossTeamText } from '@shared/constants';
import { isLeadMember, resolveRuntimeLeadName } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';

import { buildActionModeAgentBlock } from './actionModeInstructions';
import { CascadeGuard } from './CascadeGuard';
import {
  CrossTeamOutbox,
  type CrossTeamOutboxMessage,
  CrossTeamRuntimeDeliveryIdempotencyConflictError,
} from './CrossTeamOutbox';
import { resolveCrossTeamRecipientIdentity } from './CrossTeamRecipientIdentity';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';

import type { TeamCrossTeamMessagingApi } from './contracts/TeamProvisioningApis';
import type { TeamConfigReader } from './TeamConfigReader';
import type { TeamDataService } from './TeamDataService';
import type { TeamInboxWriter } from './TeamInboxWriter';
import type {
  CrossTeamRecipient,
  CrossTeamRecipientPorts,
} from '@features/team-project-context/main';
import type {
  CrossTeamMessage,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  CrossTeamTarget,
  TeamConfig,
  TeamMember,
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

  const leadName = resolveRuntimeLeadName(members);
  const leadKey = normalizeMemberKey(leadName);
  if (leadName && (rawKey === 'lead' || rawKey === 'team-lead' || rawKey === leadKey)) {
    return leadName;
  }

  throw new Error(`Unknown fromMember: ${rawFromMember}. Use a configured team member name.`);
}

export interface CrossTeamRecipientMetadataReader {
  getMembers(teamName: string): Promise<readonly TeamMember[]>;
}

function assertCrossTeamNames(fromTeam: string, toTeam: string): void {
  if (!TEAM_NAME_PATTERN.test(fromTeam)) {
    throw new Error(`Invalid fromTeam: ${fromTeam}`);
  }
  if (!TEAM_NAME_PATTERN.test(toTeam)) {
    throw new Error(`Invalid toTeam: ${toTeam}`);
  }
  if (fromTeam === toTeam) {
    throw new Error('Cannot send cross-team message to the same team');
  }
}

export class CrossTeamService {
  private cascadeGuard = new CascadeGuard();
  private outbox = new CrossTeamOutbox();

  constructor(
    private configReader: TeamConfigReader,
    private dataService: TeamDataService,
    private inboxWriter: TeamInboxWriter,
    private messaging: TeamCrossTeamMessagingApi | null,
    private recipientMetadataReader: CrossTeamRecipientMetadataReader = new TeamMembersMetaStore(),
    /** How a name is routed to a physical team; production reads the running app's registry. */
    private recipientPorts?: CrossTeamRecipientPorts
  ) {}

  /**
   * The physical team that receives a message from `fromTeam` to `toTeam`
   * (`resolveCrossTeamRecipient`): every caller, in the app and over HTTP, routes
   * through here so a per-project team is resolved the same way.
   */
  async resolveRecipient(fromTeam: string, toTeam: string): Promise<CrossTeamRecipient> {
    assertCrossTeamNames(fromTeam, toTeam);
    return this.route(fromTeam, toTeam, await this.configReader.getConfig(fromTeam));
  }

  private ports(): CrossTeamRecipientPorts {
    return this.recipientPorts ?? createAppCrossTeamRecipientPorts();
  }

  private route(
    fromTeam: string,
    toTeam: string,
    sourceConfig: TeamConfig | null
  ): Promise<CrossTeamRecipient> {
    return resolveCrossTeamRecipient(this.ports(), {
      fromTeam,
      toTeam,
      senderProjectPath: sourceConfig?.projectPath,
    });
  }

  async send(request: CrossTeamSendRequest): Promise<CrossTeamSendResult> {
    const { fromTeam, toMember, text, taskRefs, summary, actionMode } = request;
    const rawFromMember = request.fromMember;
    const chainDepth = request.chainDepth ?? 0;
    const callerMessageId = request.messageId?.trim() || undefined;
    const messageId = callerMessageId || randomUUID();
    const timestamp = request.timestamp ?? new Date().toISOString();
    const stableDedupeIdentity = Boolean(
      request.requireRuntimeDelivery && (callerMessageId || request.conversationId?.trim())
    );

    // 1. Validate
    assertCrossTeamNames(fromTeam, request.toTeam);
    if (!rawFromMember || typeof rawFromMember !== 'string' || rawFromMember.trim().length === 0) {
      throw new Error('fromMember is required');
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Message text is required');
    }

    // A per-project team has no inbox of its own: it receives through its copy for
    // the sender's project. Everything below works on that physical team.
    const sourceConfig = await this.configReader.getConfig(fromTeam);
    if (!sourceConfig || sourceConfig.deletedAt) {
      // A per-project team has no config of its own: say why it cannot send.
      await assertCrossTeamSender(this.ports(), fromTeam);
      throw new Error(`Source team not found: ${fromTeam}`);
    }
    const toTeam = (await this.route(fromTeam, request.toTeam, sourceConfig)).teamName;
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
    const fromMember = resolveCrossTeamFromMember(sourceConfig, rawFromMember.trim());

    const targetConfig = await this.configReader.getConfig(toTeam);
    if (!targetConfig || targetConfig.deletedAt) {
      throw new Error(`Target team not found: ${toTeam}`);
    }

    // 2. Resolve the recipient and lead through the same authority used by runtime delivery.
    const metaMembers = await this.recipientMetadataReader.getMembers(toTeam);
    const targetIdentity = resolveCrossTeamRecipientIdentity({
      sources: { config: targetConfig, metaMembers },
      rawToMember: toMember,
    });
    const targetMemberName = targetIdentity.memberName;
    const leadName = targetIdentity.leadName;

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

    let duplicate: CrossTeamOutboxMessage | null = null;
    try {
      ({ duplicate } = await this.outbox.appendIfNotRecent(
        fromTeam,
        outboxMessage,
        async () => {
          // 4. Cascade check only for real new deliveries
          this.cascadeGuard.check(fromTeam, toTeam, chainDepth);
          this.cascadeGuard.record(fromTeam, toTeam);
          this.messaging?.registerPendingCrossTeamReplyExpectation(
            fromTeam,
            toTeam,
            conversationId
          );

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
        {
          stableIdentity: stableDedupeIdentity,
          callerMessageId,
          ...(leadName ? { legacyToMember: leadName } : {}),
        }
      ));
    } catch (error) {
      if (
        stableDedupeIdentity &&
        error instanceof CrossTeamRuntimeDeliveryIdempotencyConflictError
      ) {
        if (
          request.timestamp === undefined &&
          this.isEquivalentRuntimeRetryIgnoringGeneratedTimestamp(
            error.existingMessage,
            outboxMessage
          )
        ) {
          duplicate = error.existingMessage;
        } else {
          this.requireDurableRuntimeDeliveryReceiptForConflict(error);
          throw error;
        }
      } else {
        throw error;
      }
    }

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
        if (!duplicate.runtimeDeliveryAcceptedAt) {
          await this.requireCrossTeamRuntimeDelivery({
            teamName: toTeam,
            memberName: duplicateTargetMemberName,
            messageId: result.messageId,
          });
          await this.outbox.markRuntimeDeliveryAccepted(fromTeam, {
            messageId: result.messageId,
            toTeam,
            toMember: duplicateTargetMemberName,
            acceptedAt: new Date().toISOString(),
          });
        }
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
      await this.outbox.markRuntimeDeliveryAccepted(fromTeam, {
        messageId,
        toTeam,
        toMember: targetMemberName,
        acceptedAt: new Date().toISOString(),
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
      const relay = targetIdentity.isLead
        ? this.messaging.relayLeadInboxMessages(toTeam)
        : this.messaging.relayInboxFileToLiveRecipient(toTeam, targetMemberName, {
            onlyMessageId: messageId,
          });
      void relay.catch((e: unknown) => {
        logger.warn(
          `Cross-team relay to ${toTeam}.${targetMemberName}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      });
    }

    return { messageId, deliveredToInbox: true, toTeam, toMember: targetMemberName };
  }

  private requireDurableRuntimeDeliveryReceiptForConflict(
    conflict: CrossTeamRuntimeDeliveryIdempotencyConflictError
  ): void {
    const existing = conflict.existingMessage;
    if (conflict.runtimeDeliveryReceiptStatus !== 'valid') {
      throw new Error(
        `Cross-team runtime delivery receipt proof is missing or corrupt for idempotency conflict: ` +
          `${existing.messageId} (${conflict.runtimeDeliveryReceiptStatus})`
      );
    }
  }

  private isEquivalentRuntimeRetryIgnoringGeneratedTimestamp(
    existing: CrossTeamOutboxMessage,
    retry: CrossTeamMessage
  ): boolean {
    return (
      existing.messageId.trim() === retry.messageId.trim() &&
      existing.fromTeam.trim() === retry.fromTeam.trim() &&
      existing.fromMember.trim() === retry.fromMember.trim() &&
      existing.toTeam.trim() === retry.toTeam.trim() &&
      existing.toMember?.trim() === retry.toMember?.trim() &&
      existing.conversationId?.trim() === retry.conversationId?.trim() &&
      existing.replyToConversationId?.trim() === retry.replyToConversationId?.trim() &&
      existing.text === retry.text &&
      (existing.summary ?? '') === (retry.summary ?? '') &&
      JSON.stringify(existing.taskRefs ?? []) === JSON.stringify(retry.taskRefs ?? []) &&
      existing.chainDepth === retry.chainDepth
    );
  }

  async listAvailableTargets(excludeTeam?: string): Promise<CrossTeamTarget[]> {
    let teams: Awaited<ReturnType<TeamDataService['listTeams']>>;
    try {
      teams = await this.dataService.listTeams();
    } catch {
      return [];
    }

    // Project copies are folded into their per-project team, which is offered
    // under its own name (a message to it is routed to the copy of the sender's
    // project). A per-project team that never ran anywhere stays a draft and is
    // not offered. A sender that is a copy does not see its own per-project team.
    // A shared team (also one that retained copies) runs and receives under its
    // own name, as before.
    const visible = await projectTeamSummaries(teams, new TeamMetaStore());
    const owner = excludeTeam ? findProjectCopyOwner(visible, excludeTeam) : null;
    const ownTeam = owner?.perProject ? owner.logicalTeamName : null;
    const isAlive = (name: string): boolean => this.messaging?.isTeamAlive(name) ?? false;
    const isOnline = (team: (typeof visible)[number]): boolean =>
      isAlive(team.teamName) ||
      (team.projectContextMode === 'per_project' &&
        (team.projectHistoryContexts ?? []).some((c) => isAlive(c.executionTeamName)));
    const targets: CrossTeamTarget[] = visible
      .filter((team) => {
        if (excludeTeam && team.teamName === excludeTeam) return false;
        if (ownTeam && team.teamName === ownTeam) return false;
        if (!TEAM_NAME_PATTERN.test(team.teamName)) return false;
        return !team.deletedAt && !team.pendingCreate;
      })
      .map((team) => {
        const summaryLead =
          team.leadName || team.leadColor
            ? { name: team.leadName, color: team.leadColor }
            : team.members?.find((member) => isLeadMember(member));
        const leadName =
          summaryLead?.name?.trim() ||
          (team.members && team.members.length > 0
            ? resolveRuntimeLeadName(team.members)
            : undefined);
        return {
          teamName: team.teamName,
          displayName: team.displayName || team.teamName,
          description: team.description,
          color: team.color,
          ...(leadName ? { leadName } : {}),
          ...(summaryLead?.color ? { leadColor: summaryLead.color } : {}),
          members: team.members?.map((member) => ({
            name: member.name,
            ...(member.role ? { role: member.role } : {}),
            ...(member.color ? { color: member.color } : {}),
          })),
          isOnline: isOnline(team),
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
    if (hasRuntimeDeliveryProof(relay, input.messageId)) {
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
    } catch (e: unknown) {
      logger.warn(
        `Failed to write sender copy for ${input.fromTeam}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }

    try {
      this.messaging?.clearPendingCrossTeamReplyExpectation(
        input.fromTeam,
        input.toTeam,
        input.conversationId
      );
    } catch (e: unknown) {
      logger.warn(
        `Failed to clear pending cross-team reply expectation for ${input.fromTeam}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
}

function hasRuntimeDeliveryProof(
  relay: Awaited<ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>>,
  expectedMessageId: string
): boolean {
  if (relay.kind === 'native_lead') {
    return relay.recentlyDeliveredMessageId === expectedMessageId;
  }

  if (relay.kind === 'native_member_noop') {
    return relay.durablyStoredMessageId === expectedMessageId;
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
